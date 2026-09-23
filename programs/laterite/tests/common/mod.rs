#![allow(dead_code, clippy::result_large_err)]

use {
    anchor_lang::{
        solana_program::{
            bpf_loader_upgradeable,
            clock::Clock,
            instruction::{AccountMeta, Instruction},
            pubkey::Pubkey,
        },
        system_program, AccountDeserialize, AccountSerialize, AnchorSerialize, InstructionData, ToAccountMetas,
    },
    laterite::{
        plan_id, Asset, Attestation, Config, ConfigParams, Engine, EnrollParams, MarketCalendar, PaymentToken,
        Settings, UserConfig, ATTESTATION_DOMAIN, ATTESTATION_SEED, CONFIG_SEED, TIERS, USER_CONFIG_SEED, VAULT_SEED,
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    solana_address_lookup_table_interface::instruction::{create_lookup_table, extend_lookup_table},
    solana_ed25519_program::new_ed25519_instruction_with_signature,
    solana_keypair::Keypair,
    solana_message::{v0, AddressLookupTableAccount, Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
    subscriptions::{
        instructions::{CancelSubscriptionBuilder, InitSubscriptionAuthorityBuilder, SubscribeBuilder},
        types::SubscribeData,
        EventAuthority, Plan, SubscriptionAuthority, SubscriptionDelegation, SUBSCRIPTIONS_ID,
    },
};

pub const PROGRAM: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/laterite.so"));

/// The mainnet Subscriptions program, pinned by `subscriptions_sha256` in the justfile.
pub const SUBSCRIPTIONS: &[u8] = include_bytes!("../fixtures/subscriptions.so");
pub const NOW: i64 = 1_790_000_000;

/// Mainnet's genesis hash, as `getGenesisHash` returns it.
pub const MAINNET_GENESIS_HASH: [u8; 32] =
    anchor_lang::pubkey!("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d").to_bytes();
/// Devnet's genesis hash, as `getGenesisHash` returns it.
pub const DEVNET_GENESIS_HASH: [u8; 32] =
    anchor_lang::pubkey!("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG").to_bytes();

pub const PYTH_PRO_ID: Pubkey = anchor_lang::pubkey!("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
pub const PYTH_STORAGE_ID: Pubkey = anchor_lang::pubkey!("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");

/// A cluster's Pyth Pro: the program binary, its storage account and the treasury that storage names.
pub struct PythDeployment {
    pub program: &'static [u8],
    pub storage: &'static [u8],
    pub treasury: Pubkey,
}

/// Mainnet's Pyth Pro, pinned by `pyth_pro_mainnet_sha256` and `pyth_storage_mainnet_sha256` in the justfile.
pub const PYTH_MAINNET: PythDeployment = PythDeployment {
    program: include_bytes!("../fixtures/pyth_pro_mainnet.so"),
    storage: include_bytes!("../fixtures/pyth_storage_mainnet.bin"),
    treasury: anchor_lang::pubkey!("Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak"),
};

/// Devnet's Pyth Pro, pinned by `pyth_pro_devnet_sha256` and `pyth_storage_devnet_sha256` in the justfile. Its
/// storage trusts Pyth's production key next to its own.
pub const PYTH_DEVNET: PythDeployment = PythDeployment {
    program: include_bytes!("../fixtures/pyth_pro_devnet.so"),
    storage: include_bytes!("../fixtures/pyth_storage_devnet.bin"),
    treasury: anchor_lang::pubkey!("opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7"),
};

/// A real update signed by Pyth's production key with SPYX/USD, QQQX/USD and six other feeds, as Kamino Scope
/// posted it in mainnet transaction
/// d5LTmTbE5NoYog5oXNNUBRFKBLS4Zokhnzotsm7GLRq2pLcLbeGTTLmUJFWrSQAsHdcn9VkxzBLzrkp3bUnyU2C.
pub const PYTH_SPYX_QQQX: &[u8] = include_bytes!("../fixtures/pyth_spyx_qqqx.bin");
/// A real USDT/USD update signed by Pyth's production key, from Pyth Pro's price API at the same time as
/// [`PYTH_SPYX_QQQX`].
pub const PYTH_USDT: &[u8] = include_bytes!("../fixtures/pyth_usdt.bin");
/// When both real updates were published, in seconds.
pub const PYTH_UPDATES_AT: i64 = 1_790_043_964;

const ED25519_PROGRAM: Pubkey = anchor_lang::pubkey!("Ed25519SigVerify111111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");
const VERIFY_MESSAGE: [u8; 8] = [180, 193, 120, 55, 189, 135, 203, 83];
/// Envelope bytes before the payload: magic, signature, public key, length.
const ENVELOPE: u16 = 4 + 64 + 32 + 2;

const TOKEN: Pubkey = anchor_spl::token::ID;
const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;

pub struct Env {
    pub svm: LiteSVM,
    pub authority: Keypair,
    /// The onboarding lookup table, once `with_plans()` has created it.
    pub onboarding_table: Option<AddressLookupTableAccount>,
}

/// The program deployed as upgradeable with `authority` as its upgrade authority.
pub fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(SUBSCRIPTIONS_ID, SUBSCRIPTIONS).unwrap();
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = NOW;
    svm.set_sysvar(&clock);
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&sponsor().pubkey(), 10_000_000_000).unwrap();
    deploy_with_authority(&mut svm, laterite::ID, authority.pubkey());

    let params = valid_params();
    for asset in params.assets {
        write_mint(&mut svm, asset.mint, asset.token_program, asset.decimals);
    }
    for token in params.payment_tokens {
        write_mint(&mut svm, token.mint, token.token_program, token.decimals);
    }

    Env { svm, authority, onboarding_table: None }
}

/// A token mint without extensions; its layout is the same under Token and Token-2022.
pub fn write_mint(svm: &mut LiteSVM, mint: Pubkey, token_program: Pubkey, decimals: u8) {
    svm.airdrop(&mint, 1_000_000_000).unwrap();
    let mut account = svm.get_account(&mint).unwrap();
    // Mint: mint authority (36) | supply (8) | decimals | is_initialized | freeze authority (36)
    let mut data = vec![0; 82];
    data[44] = decimals;
    data[45] = 1;
    account.data = data;
    account.owner = token_program;
    svm.set_account(mint, account).unwrap();
}

/// The sponsor key `valid_params()` configures; fixed, so every test knows it.
pub fn sponsor() -> Keypair {
    Keypair::new_from_array([7; 32])
}

/// The attestor key `valid_params()` configures.
pub fn attestor() -> Keypair {
    Keypair::new_from_array([8; 32])
}

pub fn funded(svm: &mut LiteSVM) -> Keypair {
    let keypair = Keypair::new();
    svm.airdrop(&keypair.pubkey(), 10_000_000_000).unwrap();
    keypair
}

pub fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instruction: Instruction,
    signers: &[&Keypair],
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let message = Message::new_with_blockhash(&[instruction], Some(&payer.pubkey()), &svm.latest_blockhash());
    let mut all = vec![payer];
    all.extend_from_slice(signers);
    let transaction = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &all).unwrap();
    let result = svm.send_transaction(transaction);
    svm.expire_blockhash();
    result
}

pub fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &laterite::ID).0
}

pub fn program_data_address() -> Pubkey {
    program_data_address_for(laterite::ID)
}

pub fn program_data_address_for(program_id: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0
}

/// Deploys `PROGRAM` under `program_id` with `authority` as its upgrade authority; returns its ProgramData address.
pub fn deploy_with_authority(svm: &mut LiteSVM, program_id: Pubkey, authority: Pubkey) -> Pubkey {
    svm.add_program(program_id, PROGRAM).unwrap();
    let program_data = program_data_address_for(program_id);
    let mut account = svm.get_account(&program_data).unwrap();
    // ProgramData metadata: u32 tag | u64 slot | Option<Pubkey> at offset 12.
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(program_data, account).unwrap();
    program_data
}

/// Mainnet: SPYx and QQQx, USDC and USDT, Pyth Pro ids, Jupiter as router, the cluster's genesis hash.
pub fn valid_params() -> ConfigParams {
    let asset = |mint: &str, pyth_feed_id| Asset {
        mint: mint.parse().unwrap(),
        token_program: TOKEN_2022,
        decimals: 8,
        pyth_feed_id,
    };
    let payment = |mint: &str, usd_feed_id| PaymentToken {
        mint: mint.parse().unwrap(),
        token_program: TOKEN,
        decimals: 6,
        usd_feed_id,
    };
    ConfigParams {
        settings: Settings {
            router: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4".parse().unwrap(),
            attestor: attestor().pubkey(),
            sponsor: sponsor().pubkey(),
            user_weekly_cap: 25_000_000,
            max_users: 100,
        },
        assets: [
            asset("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", 1843),
            asset("Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", 1837),
        ],
        payment_tokens: [
            payment("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 0),
            payment("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 8),
        ],
        genesis_hash: MAINNET_GENESIS_HASH,
    }
}

pub fn initialize_ix(authority: Pubkey, params: ConfigParams) -> Instruction {
    let mut accounts = laterite::accounts::Initialize {
        authority,
        config: config_address(),
        program: laterite::ID,
        program_data: program_data_address(),
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    let mints = params.assets.iter().map(|a| a.mint).chain(params.payment_tokens.iter().map(|t| t.mint));
    accounts.extend(mints.map(|mint| AccountMeta::new_readonly(mint, false)));
    Instruction { program_id: laterite::ID, accounts, data: laterite::instruction::Initialize { params }.data() }
}

/// `setup()` plus an initialized config with the NYSE 2026 to 2028 calendar loaded.
pub fn initialized() -> Env {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    send(&mut env.svm, &authority, initialize_ix(authority.pubkey(), valid_params()), &[]).unwrap();
    let (holidays, early_closes, valid_through) = nyse_calendar();
    let load = set_market_calendar_ix(authority.pubkey(), holidays, early_closes, valid_through);
    send(&mut env.svm, &authority, load, &[]).unwrap();
    env
}

pub fn fetch_config(svm: &LiteSVM) -> Config {
    let account = svm.get_account(&config_address()).unwrap();
    Config::try_deserialize(&mut account.data.as_slice()).unwrap()
}

pub fn custom_code(failure: &FailedTransactionMetadata) -> Option<u32> {
    match failure.err {
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => Some(code),
        _ => None,
    }
}

fn admin_accounts(admin: Pubkey) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
    laterite::accounts::AdminOnly { admin, config: config_address() }.to_account_metas(None)
}

pub fn update_config_ix(admin: Pubkey, settings: Settings) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: admin_accounts(admin),
        data: laterite::instruction::UpdateConfig { settings }.data(),
    }
}

pub fn set_paused_ix(admin: Pubkey, paused: bool) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: admin_accounts(admin),
        data: laterite::instruction::SetPaused { paused }.data(),
    }
}

pub fn propose_admin_ix(admin: Pubkey, new_admin: Pubkey) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: admin_accounts(admin),
        data: laterite::instruction::ProposeAdmin { new_admin }.data(),
    }
}

pub fn set_market_calendar_ix(
    admin: Pubkey,
    holidays: Vec<u16>,
    early_closes: Vec<u16>,
    valid_through: u16,
) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: admin_accounts(admin),
        data: laterite::instruction::SetMarketCalendar { holidays, early_closes, valid_through }.data(),
    }
}

pub fn accept_admin_ix(pending_admin: Pubkey) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: laterite::accounts::AcceptAdmin { pending_admin, config: config_address() }.to_account_metas(None),
        data: laterite::instruction::AcceptAdmin {}.data(),
    }
}

pub fn vault_address() -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED], &laterite::ID).0
}

pub fn plan_address(payment_token: usize, tier: usize) -> Pubkey {
    Plan::find_pda(&vault_address(), plan_id(payment_token, tier)).0
}

pub fn create_plan_ix(admin: Pubkey, payment_token: u8, tier: u8) -> Instruction {
    let token = valid_params().payment_tokens[payment_token as usize % 2];
    Instruction {
        program_id: laterite::ID,
        accounts: laterite::accounts::CreatePlan {
            admin,
            config: config_address(),
            vault: vault_address(),
            plan: plan_address(payment_token as usize % 2, tier as usize % 2),
            mint: token.mint,
            token_program: token.token_program,
            system_program: system_program::ID,
            subscriptions_program: SUBSCRIPTIONS_ID,
        }
        .to_account_metas(None),
        data: laterite::instruction::CreatePlan { payment_token, tier }.data(),
    }
}

/// `initialized()` plus the four plans and the onboarding lookup table, which the sponsor creates.
pub fn with_plans() -> Env {
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    for payment_token in 0..2 {
        for tier in 0..2 {
            send(&mut env.svm, &admin, create_plan_ix(admin.pubkey(), payment_token, tier), &[]).unwrap();
        }
    }
    let sponsor = sponsor();
    let slot = env.svm.get_sysvar::<Clock>().slot;
    let (create, key) = create_lookup_table(sponsor.pubkey(), sponsor.pubkey(), slot);
    let addresses = onboarding_table_addresses();
    let extend = extend_lookup_table(key, sponsor.pubkey(), Some(sponsor.pubkey()), addresses.clone());
    send(&mut env.svm, &sponsor, create, &[]).unwrap();
    send(&mut env.svm, &sponsor, extend, &[]).unwrap();
    // Addresses added to a table become usable in the next slot.
    env.svm.warp_to_slot(slot + 1);
    env.onboarding_table = Some(AddressLookupTableAccount { key, addresses });
    env
}

const ATA_PROGRAM: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Subscriptions' sentinel for an authority created in the same slot as the subscription.
pub const UNKNOWN_INIT_ID: i64 = i64::MIN;

/// The accounts every onboarding shares, which the deployment puts in the onboarding lookup table.
pub fn onboarding_table_addresses() -> Vec<Pubkey> {
    let params = valid_params();
    let mut addresses = vec![
        system_program::ID,
        TOKEN,
        TOKEN_2022,
        ATA_PROGRAM,
        SUBSCRIPTIONS_ID,
        EventAuthority::find_pda().0,
        laterite::ID,
        config_address(),
        vault_address(),
    ];
    addresses.extend(params.assets.iter().map(|asset| asset.mint));
    addresses.extend(params.payment_tokens.iter().map(|token| token.mint));
    addresses.extend((0..2).flat_map(|payment_token| (0..2).map(move |tier| plan_address(payment_token, tier))));
    addresses
}

pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

/// An initialized token account without extensions.
pub fn write_token_account(
    svm: &mut LiteSVM,
    address: Pubkey,
    mint: Pubkey,
    owner: Pubkey,
    token_program: Pubkey,
    amount: u64,
) {
    svm.airdrop(&address, 1_000_000_000).unwrap();
    let mut account = svm.get_account(&address).unwrap();
    // Account: mint (32) | owner (32) | amount (8) | delegate (36) | state | ...
    let mut data = vec![0; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    account.data = data;
    account.owner = token_program;
    svm.set_account(address, account).unwrap();
}

/// A user with no SOL and 100 USDC and 100 USDT in canonical accounts.
pub fn user_with_balances(svm: &mut LiteSVM) -> Keypair {
    fund_user(svm, Keypair::new())
}

/// Gives `user` 100 USDC and 100 USDT in canonical accounts.
pub fn fund_user(svm: &mut LiteSVM, user: Keypair) -> Keypair {
    for token in valid_params().payment_tokens {
        let address = ata(&user.pubkey(), &token.mint, &token.token_program);
        write_token_account(svm, address, token.mint, user.pubkey(), token.token_program, 100_000_000);
    }
    user
}

pub fn subscription_address(payment_token: usize, tier: usize, user: &Pubkey) -> Pubkey {
    SubscriptionDelegation::find_pda(&plan_address(payment_token, tier), user).0
}

/// `init_subscription_authority` + `subscribe` for one payment token, paid by `payer`.
pub fn subscribe_ixs(
    svm: &LiteSVM,
    user: Pubkey,
    payer: Pubkey,
    payment_token: usize,
    tier: usize,
) -> Vec<Instruction> {
    let token = valid_params().payment_tokens[payment_token];
    let plan = plan_address(payment_token, tier);
    let (_, plan_bump) = Plan::find_pda(&vault_address(), plan_id(payment_token, tier));
    let created_at = Plan::from_bytes(&svm.get_account(&plan).unwrap().data).unwrap().data.terms.created_at;
    let authority = SubscriptionAuthority::find_pda(&user, &token.mint).0;
    vec![
        InitSubscriptionAuthorityBuilder::new()
            .owner(user)
            .subscription_authority(authority)
            .token_mint(token.mint)
            .user_ata(ata(&user, &token.mint, &token.token_program))
            .token_program(token.token_program)
            .payer(Some(payer))
            .instruction(),
        SubscribeBuilder::new()
            .subscriber(user)
            .merchant(vault_address())
            .plan_pda(plan)
            .subscription_pda(subscription_address(payment_token, tier, &user))
            .subscription_authority_pda(authority)
            .event_authority(EventAuthority::find_pda().0)
            .payer(Some(payer))
            .subscribe_data(SubscribeData {
                plan_id: plan_id(payment_token, tier),
                plan_bump,
                expected_mint: token.mint,
                expected_amount: TIERS[tier],
                expected_period_hours: laterite::PLAN_PERIOD_HOURS,
                expected_created_at: created_at,
                expected_subscription_authority_init_id: UNKNOWN_INIT_ID,
            })
            .instruction(),
    ]
}

/// Cancels a user's subscription to a payment token's tier through Subscriptions, signed by the user.
pub fn cancel_subscription_ix(payment_token: usize, tier: usize, user: Pubkey) -> Instruction {
    CancelSubscriptionBuilder::new()
        .subscriber(user)
        .plan_pda(plan_address(payment_token, tier))
        .subscription_pda(subscription_address(payment_token, tier, &user))
        .event_authority(EventAuthority::find_pda().0)
        .instruction()
}

/// SPYx and $1 a day, both payment tokens at $10 a week, $20 cushions, a $1,000 goal.
pub fn default_enroll_params() -> EnrollParams {
    let mut goal_label = [0; 32];
    goal_label[..5].copy_from_slice(b"House");
    EnrollParams {
        tier: 0,
        payment_tokens: 0b11,
        asset: 0,
        engine: Engine::Daily,
        engine_amount: 1_000_000,
        income_rule: false,
        change_multiplier: 0,
        cushions: [20_000_000; 2],
        goal_amount: 1_000_000_000,
        goal_label,
    }
}

pub fn user_config_address(user: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[USER_CONFIG_SEED, user.as_ref()], &laterite::ID).0
}

pub fn fetch_user_config(env: &Env, user: &Pubkey) -> UserConfig {
    let account = env.svm.get_account(&user_config_address(user)).unwrap();
    UserConfig::try_deserialize(&mut account.data.as_slice()).unwrap()
}

pub fn enroll_ix(user: Pubkey, payer: Pubkey, params: EnrollParams, subscriptions: &[Pubkey]) -> Instruction {
    let mut accounts = laterite::accounts::Enroll {
        user,
        payer,
        config: config_address(),
        user_config: user_config_address(&user),
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts.extend(subscriptions.iter().map(|subscription| AccountMeta::new_readonly(*subscription, false)));
    Instruction { program_id: laterite::ID, accounts, data: laterite::instruction::Enroll { params }.data() }
}

/// The whole onboarding: the asset's ATA, then per enabled token the authority and subscription, then `enroll`.
pub fn onboarding_ixs(svm: &LiteSVM, user: Pubkey, payer: Pubkey, params: &EnrollParams) -> Vec<Instruction> {
    let asset = valid_params().assets[params.asset as usize % 2];
    let mut instructions = vec![Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(ata(&user, &asset.mint, &asset.token_program), false),
            AccountMeta::new_readonly(user, false),
            AccountMeta::new_readonly(asset.mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(asset.token_program, false),
        ],
        // CreateIdempotent
        data: vec![1],
    }];
    let mut subscriptions = vec![];
    for payment_token in (0..2).filter(|i| params.payment_tokens & (1 << i) != 0) {
        instructions.extend(subscribe_ixs(svm, user, payer, payment_token, params.tier as usize % 2));
        subscriptions.push(subscription_address(payment_token, params.tier as usize % 2, &user));
    }
    instructions.push(enroll_ix(user, payer, params.clone(), &subscriptions));
    instructions
}

/// Sends several instructions in one version 0 transaction that uses the onboarding lookup table when it exists;
/// returns its size too.
pub fn send_many(
    env: &mut Env,
    payer: &Keypair,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> (usize, Result<TransactionMetadata, FailedTransactionMetadata>) {
    let tables = env.onboarding_table.as_slice();
    let message = v0::Message::try_compile(&payer.pubkey(), instructions, tables, env.svm.latest_blockhash()).unwrap();
    let mut all = vec![payer];
    all.extend_from_slice(signers);
    let transaction = VersionedTransaction::try_new(VersionedMessage::V0(message), &all).unwrap();
    let size = bincode::serialize(&transaction).unwrap().len();
    let result = env.svm.send_transaction(transaction);
    env.svm.expire_blockhash();
    (size, result)
}

/// The NYSE calendar the deployment loads.
fn nyse_calendar_file() -> serde_json::Value {
    serde_json::from_str(include_str!("../../data/nyse-calendar.json")).unwrap()
}

/// A `YYYY-MM-DD` date as (year, month, day).
fn date(value: &serde_json::Value) -> (i64, i64, i64) {
    let parts: Vec<i64> = value.as_str().unwrap().split('-').map(|part| part.parse().unwrap()).collect();
    (parts[0], parts[1], parts[2])
}

/// NYSE full-day closures.
pub fn nyse_holidays() -> Vec<(i64, i64, i64)> {
    nyse_calendar_file()["holidays"].as_array().unwrap().iter().map(date).collect()
}

/// NYSE early closes, at 13:00 New York time.
pub fn nyse_early_closes() -> Vec<(i64, i64, i64)> {
    nyse_calendar_file()["earlyCloses"].as_array().unwrap().iter().map(date).collect()
}

/// The last day the NYSE calendar covers.
pub fn nyse_valid_through() -> (i64, i64, i64) {
    date(&nyse_calendar_file()["validThrough"])
}

/// Days from 1970-01-01 to a date, counted month by month.
pub fn day((year, month, day): (i64, i64, i64)) -> u16 {
    let leap = |y: i64| y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let years: i64 = (1970..year).map(|y| if leap(y) { 366 } else { 365 }).sum();
    let lengths = [31, if leap(year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let months: i64 = lengths[..month as usize - 1].iter().sum();
    (years + months + day - 1) as u16
}

/// The NYSE calendar as days since 1970-01-01: holidays, early closes and the last day covered.
pub fn nyse_calendar() -> (Vec<u16>, Vec<u16>, u16) {
    let days = |dates: Vec<(i64, i64, i64)>| dates.into_iter().map(day).collect();
    (days(nyse_holidays()), days(nyse_early_closes()), day(nyse_valid_through()))
}

/// The NYSE calendar as the program keeps it, loaded on 2026-01-01.
pub fn nyse_market_calendar() -> MarketCalendar {
    let (holidays, early_closes, valid_through) = nyse_calendar();
    MarketCalendar::new(&holidays, &early_closes, valid_through, day((2026, 1, 1)).into()).unwrap()
}

/// Loads a cluster's Pyth Pro program with its storage account and a funded treasury.
pub fn add_pyth(svm: &mut LiteSVM, pyth: &PythDeployment) {
    svm.add_program(PYTH_PRO_ID, pyth.program).unwrap();
    svm.airdrop(&PYTH_STORAGE_ID, 3_542_640).unwrap();
    let mut storage = svm.get_account(&PYTH_STORAGE_ID).unwrap();
    storage.data = pyth.storage.to_vec();
    storage.owner = PYTH_PRO_ID;
    svm.set_account(PYTH_STORAGE_ID, storage).unwrap();
    svm.airdrop(&pyth.treasury, 1_000_000_000).unwrap();
}

/// The ed25519 precompile instruction over Solana-format messages, each given with the index of the instruction
/// whose data holds it and its offset there, the layout Pyth Pro checks. A message's position in `messages` is
/// the `signature_index` Pyth Pro's `verify_message` takes for it.
pub fn ed25519_ix(messages: &[(&[u8], u16, u16)]) -> Instruction {
    let mut data = vec![messages.len() as u8, 0];
    for &(message, instruction_index, offset) in messages {
        let signature = offset + 4;
        let public_key = signature + 64;
        let payload = offset + ENVELOPE;
        let payload_len = message.len() as u16 - ENVELOPE;
        let offsets =
            [signature, instruction_index, public_key, instruction_index, payload, payload_len, instruction_index];
        data.extend(offsets.iter().flat_map(|value| value.to_le_bytes()));
    }
    Instruction { program_id: ED25519_PROGRAM, accounts: vec![], data }
}

/// Pyth Pro's `verify_message` for `message`, whose signature is entry `signature_index` of the ed25519
/// instruction at `ed25519_index`. The message starts at offset 12 of this instruction's data: discriminator, then
/// the `Vec` length.
pub fn verify_message_ix(
    payer: Pubkey,
    treasury: Pubkey,
    message: &[u8],
    ed25519_index: u16,
    signature_index: u8,
) -> Instruction {
    let mut data = VERIFY_MESSAGE.to_vec();
    data.extend((message.len() as u32).to_le_bytes());
    data.extend(message);
    data.extend(ed25519_index.to_le_bytes());
    data.push(signature_index);
    Instruction {
        program_id: PYTH_PRO_ID,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(PYTH_STORAGE_ID, false),
            AccountMeta::new(treasury, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR, false),
        ],
        data,
    }
}

/// Replaces the envelope's signature and public key with `signer`'s over the same payload.
pub fn signed_by(message: &[u8], signer: &Keypair) -> Vec<u8> {
    let mut resigned = message.to_vec();
    let signature = signer.sign_message(&message[usize::from(ENVELOPE)..]);
    resigned[4..68].copy_from_slice(signature.as_ref());
    resigned[68..100].copy_from_slice(signer.pubkey().as_ref());
    resigned
}

pub fn set_now(svm: &mut LiteSVM, now: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = now;
    svm.set_sysvar(&clock);
}

pub fn write_user_config(env: &mut Env, user_config: &UserConfig) {
    let address = user_config_address(&user_config.user);
    let mut account = env.svm.get_account(&address).unwrap();
    account.data.clear();
    user_config.try_serialize(&mut account.data).unwrap();
    env.svm.set_account(address, account).unwrap();
}

/// `user`, funded and enrolled by the sponsor with `params`.
pub fn enrolled(env: &mut Env, user: Keypair, params: &EnrollParams) -> Keypair {
    let user = fund_user(&mut env.svm, user);
    let instructions = onboarding_ixs(&env.svm, user.pubkey(), sponsor().pubkey(), params);
    send_many(env, &sponsor(), &instructions, &[&user]).1.unwrap();
    user
}

/// The transfer's record address and canonical bump.
pub fn find_attestation_record(attestation: &Attestation) -> (Pubkey, u8) {
    let seeds: &[&[u8]] = &[
        ATTESTATION_SEED,
        attestation.user.as_ref(),
        &attestation.signature[..32],
        &attestation.signature[32..],
        &attestation.transfer_index.to_le_bytes(),
    ];
    Pubkey::find_program_address(seeds, &laterite::ID)
}

pub fn attestation_record_address(attestation: &Attestation) -> Pubkey {
    find_attestation_record(attestation).0
}

/// What the attestor signs for `attestation` in the deployment of `program` on the cluster with `genesis_hash`.
pub fn attestation_message(program: &Pubkey, genesis_hash: &[u8; 32], attestation: &Attestation) -> Vec<u8> {
    let mut message = [ATTESTATION_DOMAIN, program.as_ref(), genesis_hash].concat();
    attestation.serialize(&mut message).unwrap();
    message
}

/// The ed25519 precompile instruction in its standard single-signature layout: `signer`'s signature over `message`.
pub fn signature_ix(message: &[u8], signer: &Keypair) -> Instruction {
    let signature = signer.sign_message(message).into();
    new_ed25519_instruction_with_signature(message, &signature, &signer.pubkey().to_bytes())
}

pub fn attest_ix(payer: Pubkey, attestation: &Attestation) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: laterite::accounts::Attest {
            payer,
            config: config_address(),
            user_config: user_config_address(&attestation.user),
            record: attestation_record_address(attestation),
            instructions: INSTRUCTIONS_SYSVAR,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: laterite::instruction::Attest { attestation: attestation.clone() }.data(),
    }
}

/// `signer`'s signature over `attestation` for this deployment (`valid_params()`: mainnet), then `attest`.
pub fn attest_ixs(payer: Pubkey, attestation: &Attestation, signer: &Keypair) -> [Instruction; 2] {
    let message = attestation_message(&laterite::ID, &MAINNET_GENESIS_HASH, attestation);
    [signature_ix(&message, signer), attest_ix(payer, attestation)]
}

/// Sends `attest_ixs` in one transaction; returns its compute units.
pub fn submit_attestation(
    env: &mut Env,
    payer: &Keypair,
    attestation: &Attestation,
    signer: &Keypair,
) -> Result<u64, FailedTransactionMetadata> {
    let instructions = attest_ixs(payer.pubkey(), attestation, signer);
    send_many(env, payer, &instructions, &[]).1.map(|metadata| metadata.compute_units_consumed)
}

pub fn close_attestation_ix(record: Pubkey, payer: Pubkey) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: laterite::accounts::CloseAttestation { record, payer }.to_account_metas(None),
        data: laterite::instruction::CloseAttestation {}.data(),
    }
}
