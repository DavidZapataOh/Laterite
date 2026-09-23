#![allow(dead_code, clippy::result_large_err)]

use {
    anchor_lang::{
        event::EVENT_IX_TAG_LE,
        solana_program::{
            bpf_loader_upgradeable,
            clock::Clock,
            instruction::{AccountMeta, Instruction},
            pubkey::Pubkey,
        },
        system_program, AccountDeserialize, AccountSerialize, AnchorDeserialize, AnchorSerialize, Discriminator,
        InstructionData, ToAccountMetas,
    },
    laterite::{
        events::Swept, plan_id, Asset, Attestation, Config, ConfigParams, Engine, EnrollParams, MarketCalendar,
        PaymentToken, Quote, Settings, UserConfig, ATTESTATION_DOMAIN, ATTESTATION_SEED, CONFIG_SEED, SWAP_AUTHORITY,
        TIERS, USER_CONFIG_SEED, VAULT_SEED,
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    solana_address_lookup_table_interface::instruction::{create_lookup_table, extend_lookup_table},
    solana_ed25519_program::new_ed25519_instruction_with_signature,
    solana_keypair::Keypair,
    solana_message::{v0, v1, AddressLookupTableAccount, Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
    subscriptions::{
        instructions::{
            CancelSubscriptionBuilder, InitSubscriptionAuthorityBuilder, RevokeDelegationBuilder,
            RevokeSubscriptionAuthorityBuilder, SubscribeBuilder,
        },
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

/// Both clusters' Pyth Pro, with their names; devnet is where the product runs.
pub const PYTH_DEPLOYMENTS: [(&str, PythDeployment); 2] = [("mainnet", PYTH_MAINNET), ("devnet", PYTH_DEVNET)];

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
/// The real updates' SPYX/USD, QQQX/USD and USDT/USD quotes.
pub const PYTH_SPYX_QUOTE: Quote = Quote { price: 77_847_155_496, confidence: 30_532_893, exponent: -8 };
pub const PYTH_QQQX_QUOTE: Quote = Quote { price: 74_597_430_644, confidence: 40_282_152, exponent: -8 };
pub const PYTH_USDT_QUOTE: Quote = Quote { price: 99_972_708, confidence: 7_028, exponent: -8 };

/// Our devnet deployment of Raydium CPMM and the devnet accounts the sweep tests copy, from
/// `packages/devnet/addresses.json`; `just dump-devnet-accounts` refreshes their fixtures.
pub const CPMM: Pubkey = anchor_lang::pubkey!("GVSWUkxEj83o4xmcNRDc4p6wSTE7mB3g8BXZRXq8Wcx3");
pub const CPMM_CONFIG: Pubkey = anchor_lang::pubkey!("8zfcVMo8dgJZUECxJELLrPNjAfK7CeC8o9hYgYGPsyQQ");
pub const SPYX: Pubkey = anchor_lang::pubkey!("Av85xasqSyE6KfyW85h1RJXBs631sExR5ncFoHhtEDnU");
pub const QQQX: Pubkey = anchor_lang::pubkey!("8zYS2UR5aFM6PxDWsEjyRWHsco1PSxHubDC8pSetwxcN");
pub const USDC: Pubkey = anchor_lang::pubkey!("GHxn9udETkoqKzXgeqk24gT2RzptcjTo2p9WtWxo618c");
pub const USDT: Pubkey = anchor_lang::pubkey!("J2jptCQwMHYw6PK5qdGVmd85SYU4FxUGk1tViJ18WG4x");
/// The mainnet Raydium CPMM program built from source with only its devnet ids and admin replaced, pinned by
/// `cpmm_sha256` in the justfile.
pub const CPMM_PROGRAM: &[u8] = include_bytes!("../fixtures/cpmm.so");
/// A router that runs the instructions its data encodes (`tests/router`), for routes no real router builds.
pub const TEST_ROUTER: Pubkey = Pubkey::new_from_array([42; 32]);
pub const TEST_ROUTER_PROGRAM: &[u8] =
    include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/test_router.so"));

/// A CPMM pool of an asset against a payment token: token 0 is the asset, token 1 the payment token.
pub struct Pool {
    pub address: Pubkey,
    pub observation: Pubkey,
    pub asset_vault: Pubkey,
    pub payment_vault: Pubkey,
    pub asset_mint: Pubkey,
    pub payment_mint: Pubkey,
}

/// The devnet pools the tests copy: SPYx against each payment token, and QQQx against USDC.
pub const POOLS: [Pool; 3] = [
    Pool {
        address: anchor_lang::pubkey!("DgyosfpJ2cxnm1mAoB4mgE2XSwKCJJR6jjD9stsCaLTP"),
        observation: anchor_lang::pubkey!("4XxfjDUvQxQ5zUk42B23hJFN9fx4baCDC2gAMLrwGxmz"),
        asset_vault: anchor_lang::pubkey!("9kxJhx8xjATHKznRdtn3k9NJNqUkCMgrWw7Lh2iunYUZ"),
        payment_vault: anchor_lang::pubkey!("E54M3Mnyk9sxuNz8SQ4ddhjj48kUwZYrnwioPFmgTTF3"),
        asset_mint: SPYX,
        payment_mint: USDC,
    },
    Pool {
        address: anchor_lang::pubkey!("DVksHcPfMUttsUtoT8EwSHHVmNYyM6Lr9EHr8oQbRMkm"),
        observation: anchor_lang::pubkey!("5DwKvikLgTsAC44gMbvPib29A1W8CzY1x14CM4n1jnFc"),
        asset_vault: anchor_lang::pubkey!("CRarcATyPyjGkBnpNBW1agwsTcYQKPFGSM2kPQBQoQ5k"),
        payment_vault: anchor_lang::pubkey!("9w91fL95LatF9L8seod2fJxp2Kw5PCje2ShNGpnAXUkf"),
        asset_mint: SPYX,
        payment_mint: USDT,
    },
    Pool {
        address: anchor_lang::pubkey!("5YQMCKnFmVxiNhnJvPJFjecFtUvF4dx9oRz9r7gmNZXP"),
        observation: anchor_lang::pubkey!("8xndDN7YyqZsVnbJ94Ap9Y3vRrKiCqrKAKNT5ic1e7sB"),
        asset_vault: anchor_lang::pubkey!("7BM6mfhSVjFjjmqr7YKaqhhiaL4up7CPxxKNhLYShrbk"),
        payment_vault: anchor_lang::pubkey!("5ttnh7ZizzBYiS46Ngjq4yL7TJXEdxQcMFaTNznXMcCd"),
        asset_mint: QQQX,
        payment_mint: USDC,
    },
];

/// The pool of `asset_mint` against `payment_mint`.
pub fn pool(asset_mint: Pubkey, payment_mint: Pubkey) -> &'static Pool {
    POOLS.iter().find(|pool| pool.asset_mint == asset_mint && pool.payment_mint == payment_mint).unwrap()
}

const ED25519_PROGRAM: Pubkey = anchor_lang::pubkey!("Ed25519SigVerify111111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");
const VERIFY_MESSAGE: [u8; 8] = [180, 193, 120, 55, 189, 135, 203, 83];
/// Envelope bytes before the payload: magic, signature, public key, length.
const ENVELOPE: u16 = 4 + 64 + 32 + 2;

const TOKEN: Pubkey = anchor_spl::token::ID;
const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const SWAP_BASE_INPUT: [u8; 8] = [143, 190, 90, 218, 196, 30, 51, 222];

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

/// Devnet: the stand-ins of SPYx and QQQx, USDC and USDT, Pyth Pro ids, our CPMM as router, the cluster's genesis
/// hash.
pub fn valid_params() -> ConfigParams {
    let asset = |mint, pyth_feed_id| Asset { mint, token_program: TOKEN_2022, decimals: 8, pyth_feed_id };
    let payment = |mint, usd_feed_id| PaymentToken { mint, token_program: TOKEN, decimals: 6, usd_feed_id };
    ConfigParams {
        settings: Settings {
            attestor: attestor().pubkey(),
            sponsor: sponsor().pubkey(),
            user_weekly_cap: 25_000_000,
            max_users: 100,
        },
        assets: [asset(SPYX, 1843), asset(QQQX, 1837)],
        payment_tokens: [payment(USDC, 0), payment(USDT, 8)],
        genesis_hash: DEVNET_GENESIS_HASH,
        router: CPMM,
    }
}

pub fn initialize_ix(authority: Pubkey, params: ConfigParams) -> Instruction {
    let mut accounts = laterite::accounts::Initialize {
        authority,
        config: config_address(),
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
    initialize(setup(), valid_params())
}

/// Initializes `env` with `params` and loads the NYSE 2026 to 2028 calendar.
pub fn initialize(mut env: Env, params: ConfigParams) -> Env {
    let authority = env.authority.insecure_clone();
    send(&mut env.svm, &authority, initialize_ix(authority.pubkey(), params), &[]).unwrap();
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
    add_plans(initialized())
}

/// Creates the four plans and the onboarding lookup table in an initialized `env`.
pub fn add_plans(mut env: Env) -> Env {
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

/// `subscribe` to a payment token's tier, paid by `payer`, preceded by `init_subscription_authority` when the user has
/// no authority for the token yet.
pub fn subscribe_ixs(
    svm: &LiteSVM,
    user: Pubkey,
    payer: Pubkey,
    payment_token: usize,
    tier: usize,
) -> Vec<Instruction> {
    let token = valid_params().payment_tokens[payment_token];
    let authority = SubscriptionAuthority::find_pda(&user, &token.mint).0;
    if let Some(account) = svm.get_account(&authority).filter(|account| account.owner == SUBSCRIPTIONS_ID) {
        let init_id = SubscriptionAuthority::from_bytes(&account.data).unwrap().init_id;
        return vec![subscribe_ix(svm, user, payer, payment_token, tier, init_id)];
    }
    vec![
        InitSubscriptionAuthorityBuilder::new()
            .owner(user)
            .subscription_authority(authority)
            .token_mint(token.mint)
            .user_ata(ata(&user, &token.mint, &token.token_program))
            .token_program(token.token_program)
            .payer(Some(payer))
            .instruction(),
        subscribe_ix(svm, user, payer, payment_token, tier, UNKNOWN_INIT_ID),
    ]
}

/// `subscribe` to a payment token's tier through the user's authority for the token, created with `init_id`.
pub fn subscribe_ix(
    svm: &LiteSVM,
    user: Pubkey,
    payer: Pubkey,
    payment_token: usize,
    tier: usize,
    init_id: i64,
) -> Instruction {
    let token = valid_params().payment_tokens[payment_token];
    let plan = plan_address(payment_token, tier);
    let (_, plan_bump) = Plan::find_pda(&vault_address(), plan_id(payment_token, tier));
    let created_at = Plan::from_bytes(&svm.get_account(&plan).unwrap().data).unwrap().data.terms.created_at;
    SubscribeBuilder::new()
        .subscriber(user)
        .merchant(vault_address())
        .plan_pda(plan)
        .subscription_pda(subscription_address(payment_token, tier, &user))
        .subscription_authority_pda(SubscriptionAuthority::find_pda(&user, &token.mint).0)
        .event_authority(EventAuthority::find_pda().0)
        .payer(Some(payer))
        .subscribe_data(SubscribeData {
            plan_id: plan_id(payment_token, tier),
            plan_bump,
            expected_mint: token.mint,
            expected_amount: TIERS[tier],
            expected_period_hours: laterite::PLAN_PERIOD_HOURS,
            expected_created_at: created_at,
            expected_subscription_authority_init_id: init_id,
        })
        .instruction()
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
    let mut instructions = vec![create_ata_ix(payer, user, asset.mint, asset.token_program)];
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

/// `signer`'s signature over `attestation` for this deployment (`valid_params()`: devnet), then `attest`.
pub fn attest_ixs(payer: Pubkey, attestation: &Attestation, signer: &Keypair) -> [Instruction; 2] {
    let message = attestation_message(&laterite::ID, &DEVNET_GENESIS_HASH, attestation);
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

/// The associated token program's `CreateIdempotent`.
pub fn create_ata_ix(payer: Pubkey, owner: Pubkey, mint: Pubkey, token_program: Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(ata(&owner, &mint, &token_program), false),
            AccountMeta::new_readonly(owner, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(token_program, false),
        ],
        data: vec![1],
    }
}

/// Writes the committed copy of a devnet account.
pub fn load_devnet_account(svm: &mut LiteSVM, address: Pubkey, owner: Pubkey) {
    let path = format!("{}/tests/fixtures/devnet/{address}.bin", env!("CARGO_MANIFEST_DIR"));
    let data = std::fs::read(path).unwrap();
    svm.airdrop(&address, svm.minimum_balance_for_rent_exemption(data.len())).unwrap();
    let mut account = svm.get_account(&address).unwrap();
    account.data = data;
    account.owner = owner;
    svm.set_account(address, account).unwrap();
}

/// A token account's raw `amount`, at the same offset under Token and Token-2022.
pub fn token_amount(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    u64::from_le_bytes(svm.get_account(token_account).unwrap().data[64..72].try_into().unwrap())
}

pub fn write_amount(svm: &mut LiteSVM, token_account: Pubkey, amount: u64) {
    let mut account = svm.get_account(&token_account).unwrap();
    account.data[64..72].copy_from_slice(&amount.to_le_bytes());
    svm.set_account(token_account, account).unwrap();
}

/// Asset held by every test pool: 1,000 whole tokens.
const POOL_DEPTH: u64 = 1_000 * 100_000_000;

/// Prices `pool` at `price` per whole asset token, `bps` above it: reserves are the vault balances once the pool's
/// accrued protocol, fund and creator fees (offsets 341–413 of its state) are cleared.
pub fn peg(svm: &mut LiteSVM, pool: &Pool, price: Quote, bps: i64) {
    let mut state = svm.get_account(&pool.address).unwrap();
    for offset in [341, 349, 357, 365, 397, 405] {
        state.data[offset..offset + 8].fill(0);
    }
    svm.set_account(pool.address, state).unwrap();
    let worth = u128::from(POOL_DEPTH) * u128::from(price.price) / 10u128.pow(10);
    let payment = worth * (10_000 + bps) as u128 / 10_000;
    write_amount(svm, pool.asset_vault, POOL_DEPTH);
    write_amount(svm, pool.payment_vault, payment as u64);
}

pub fn write_config(env: &mut Env, config: &Config) {
    let mut account = env.svm.get_account(&config_address()).unwrap();
    account.data.clear();
    config.try_serialize(&mut account.data).unwrap();
    env.svm.set_account(config_address(), account).unwrap();
}

/// Adds `signer` to the LiteSVM copy of Pyth Pro's storage as a trusted key, for updates no real one carries. Test
/// only: devnet and mainnet trust Pyth's keys alone.
pub fn trust(svm: &mut LiteSVM, signer: &Keypair) {
    let mut storage = svm.get_account(&PYTH_STORAGE_ID).unwrap();
    // Storage: the trusted-signer count at 80, then 40-byte slots of public key and expiry.
    let slot = 81 + 40 * usize::from(storage.data[80]);
    storage.data[80] += 1;
    storage.data[slot..slot + 32].copy_from_slice(signer.pubkey().as_ref());
    storage.data[slot + 32..slot + 40].copy_from_slice(&i64::MAX.to_le_bytes());
    svm.set_account(PYTH_STORAGE_ID, storage).unwrap();
}

/// The key the sweep tests' Pyth Pro storage trusts for composed updates.
pub fn pyth_test_signer() -> Keypair {
    Keypair::new_from_array([5; 32])
}

/// A Solana-format Pyth Pro update composed for a test: `feeds` with price, exponent, confidence and a feed update
/// time of `at`, signed by [`pyth_test_signer`].
pub fn pyth_update(at: i64, feeds: &[(u32, Quote)]) -> Vec<u8> {
    let micros = (at as u64 * 1_000_000).to_le_bytes();
    let mut payload = 2_479_346_549u32.to_le_bytes().to_vec();
    payload.extend(micros);
    payload.extend([3, feeds.len() as u8]);
    for (id, quote) in feeds {
        payload.extend(id.to_le_bytes());
        payload.extend([4, 0]);
        payload.extend(quote.price.to_le_bytes());
        payload.push(4);
        payload.extend(quote.exponent.to_le_bytes());
        payload.push(5);
        payload.extend(quote.confidence.to_le_bytes());
        payload.extend([12, 1]);
        payload.extend(micros);
    }
    let mut message = 2_182_742_457u32.to_le_bytes().to_vec();
    message.extend(pyth_test_signer().sign_message(&payload).as_ref());
    message.extend(pyth_test_signer().pubkey().as_ref());
    message.extend((payload.len() as u16).to_le_bytes());
    message.extend(payload);
    message
}

/// Updates composed at `at` with the real quotes: SPYX and QQQX and, for USDT, USDT.
pub fn composed_updates(payment_token: usize, at: i64) -> (Vec<u8>, Vec<u8>) {
    let asset = pyth_update(at, &[(1843, PYTH_SPYX_QUOTE), (1837, PYTH_QQQX_QUOTE)]);
    let payment = if payment_token == 1 { pyth_update(at, &[(8, PYTH_USDT_QUOTE)]) } else { vec![] };
    (asset, payment)
}

/// The ed25519 instruction of a sweep at index 1: signature entry 0 is the asset update, at offset 12 of the sweep's
/// data, and entry 1, when there is one, the payment update after it.
pub fn sweep_ed25519_ix(asset_message: &[u8], payment_message: &[u8]) -> Instruction {
    let mut entries = vec![(asset_message, 1, 12)];
    if !payment_message.is_empty() {
        entries.push((payment_message, 1, 16 + asset_message.len() as u16));
    }
    ed25519_ix(&entries)
}

pub struct SweepEnv {
    pub env: Env,
    pub user: Keypair,
    pub crank: Keypair,
    pub pyth_treasury: Pubkey,
}

/// A user enrolled with `params` against copies of the devnet mints, CPMM and pools and devnet's Pyth Pro, with our
/// CPMM as router; see [`sweep_env_with`].
pub fn sweep_env(params: &EnrollParams) -> SweepEnv {
    sweep_env_with(&PYTH_DEVNET, CPMM, params)
}

/// A user enrolled with `params` against copies of the devnet mints, CPMM and pools and `pyth`'s Pyth Pro, which
/// also trusts [`pyth_test_signer`], in a deployment whose router is `router`. The clock is at the real updates' time
/// and each pool at its asset's price in them; the swap authority has its payment-token accounts.
pub fn sweep_env_with(pyth: &PythDeployment, router: Pubkey, params: &EnrollParams) -> SweepEnv {
    let mut env = setup();
    let svm = &mut env.svm;
    for (address, owner) in [(CPMM_CONFIG, CPMM), (SPYX, TOKEN_2022), (QQQX, TOKEN_2022), (USDC, TOKEN), (USDT, TOKEN)]
    {
        load_devnet_account(svm, address, owner);
    }
    for pool in &POOLS {
        for (address, owner) in [
            (pool.address, CPMM),
            (pool.observation, CPMM),
            (pool.asset_vault, TOKEN_2022),
            (pool.payment_vault, TOKEN),
        ] {
            load_devnet_account(svm, address, owner);
        }
    }
    svm.add_program(CPMM, CPMM_PROGRAM).unwrap();
    svm.add_program(TEST_ROUTER, TEST_ROUTER_PROGRAM).unwrap();
    add_pyth(svm, pyth);
    trust(svm, &pyth_test_signer());

    let mut env = add_plans(initialize(env, ConfigParams { router, ..valid_params() }));
    let admin = env.authority.insecure_clone();
    for token in valid_params().payment_tokens {
        let create = create_ata_ix(admin.pubkey(), SWAP_AUTHORITY, token.mint, token.token_program);
        send(&mut env.svm, &admin, create, &[]).unwrap();
    }
    let user = enrolled(&mut env, Keypair::new_from_array([11; 32]), params);
    set_now(&mut env.svm, PYTH_UPDATES_AT);
    for pool in &POOLS {
        let price = if pool.asset_mint == SPYX { PYTH_SPYX_QUOTE } else { PYTH_QQQX_QUOTE };
        peg(&mut env.svm, pool, price, 0);
    }
    let crank = funded(&mut env.svm);
    SweepEnv { env, user, crank, pyth_treasury: pyth.treasury }
}

impl SweepEnv {
    pub fn user_payment_account(&self, payment_token: usize) -> Pubkey {
        let token = valid_params().payment_tokens[payment_token];
        ata(&self.user.pubkey(), &token.mint, &token.token_program)
    }

    pub fn swap_payment_account(&self, payment_token: usize) -> Pubkey {
        let token = valid_params().payment_tokens[payment_token];
        ata(&SWAP_AUTHORITY, &token.mint, &token.token_program)
    }

    pub fn asset_mint(&self) -> Pubkey {
        valid_params().assets[usize::from(fetch_user_config(&self.env, &self.user.pubkey()).asset)].mint
    }

    pub fn user_asset_account(&self) -> Pubkey {
        ata(&self.user.pubkey(), &self.asset_mint(), &TOKEN_2022)
    }

    /// What a sweep of `payment_token` pulls now, computed as a crank does: the amount engine, within what the
    /// subscription's current period still allows.
    pub fn due(&self, payment_token: usize) -> u64 {
        let user = self.user.pubkey();
        let user_config = fetch_user_config(&self.env, &user);
        let config = fetch_config(&self.env.svm);
        let balance = token_amount(&self.env.svm, &self.user_payment_account(payment_token));
        let now = self.env.svm.get_sysvar::<Clock>().unix_timestamp;
        let subscription = subscription_address(payment_token, usize::from(user_config.tier), &user);
        let native = native_remaining(&self.env.svm, &subscription, now);
        let pull = user_config.pull(payment_token, balance, config.user_weekly_cap, &config.market_calendar, now);
        pull.capped(native).total()
    }

    /// `swap_base_input` on the pool of the user's asset against the payment token, from the swap authority into the
    /// user's asset account, with no minimum of its own.
    pub fn cpmm_swap_ix(&self, payment_token: usize, amount_in: u64) -> Instruction {
        let pool = pool(self.asset_mint(), valid_params().payment_tokens[payment_token].mint);
        let authority = Pubkey::find_program_address(&[b"vault_and_lp_mint_auth_seed"], &CPMM).0;
        let accounts = vec![
            AccountMeta::new_readonly(SWAP_AUTHORITY, false),
            AccountMeta::new_readonly(authority, false),
            AccountMeta::new_readonly(CPMM_CONFIG, false),
            AccountMeta::new(pool.address, false),
            AccountMeta::new(self.swap_payment_account(payment_token), false),
            AccountMeta::new(self.user_asset_account(), false),
            AccountMeta::new(pool.payment_vault, false),
            AccountMeta::new(pool.asset_vault, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
            AccountMeta::new_readonly(pool.payment_mint, false),
            AccountMeta::new_readonly(pool.asset_mint, false),
            AccountMeta::new(pool.observation, false),
        ];
        let mut data = SWAP_BASE_INPUT.to_vec();
        data.extend(amount_in.to_le_bytes());
        data.extend(0u64.to_le_bytes());
        Instruction { program_id: CPMM, accounts, data }
    }

    /// The route of [`Self::cpmm_swap_ix`] through the CPMM as router: its data and accounts.
    pub fn cpmm_route(&self, payment_token: usize, amount_in: u64) -> (Vec<u8>, Vec<AccountMeta>) {
        let swap = self.cpmm_swap_ix(payment_token, amount_in);
        (swap.data, swap.accounts)
    }

    pub fn sweep_ix(
        &self,
        payment_token: usize,
        asset_message: &[u8],
        payment_message: &[u8],
        route: Vec<u8>,
        route_accounts: Vec<AccountMeta>,
    ) -> Instruction {
        let user = self.user.pubkey();
        let token = valid_params().payment_tokens[payment_token];
        let tier = usize::from(fetch_user_config(&self.env, &user).tier);
        let mut accounts = laterite::accounts::Sweep {
            crank: self.crank.pubkey(),
            config: config_address(),
            user_config: user_config_address(&user),
            vault: vault_address(),
            subscription: subscription_address(payment_token, tier, &user),
            plan: plan_address(payment_token, tier),
            subscription_authority: SubscriptionAuthority::find_pda(&user, &token.mint).0,
            user_payment_account: self.user_payment_account(payment_token),
            swap_payment_account: self.swap_payment_account(payment_token),
            user_asset_account: self.user_asset_account(),
            payment_mint: token.mint,
            payment_token_program: token.token_program,
            subscriptions_program: SUBSCRIPTIONS_ID,
            subscriptions_event_authority: EventAuthority::find_pda().0,
            swap_authority: SWAP_AUTHORITY,
            router: fetch_config(&self.env.svm).router,
            pyth_program: PYTH_PRO_ID,
            pyth_storage: PYTH_STORAGE_ID,
            pyth_treasury: self.pyth_treasury,
            instructions: INSTRUCTIONS_SYSVAR,
            system_program: system_program::ID,
            event_authority: Pubkey::find_program_address(&[b"__event_authority"], &laterite::ID).0,
            program: laterite::ID,
        }
        .to_account_metas(None);
        accounts.extend(route_accounts);
        let data = laterite::instruction::Sweep {
            asset_message: asset_message.to_vec(),
            payment_message: payment_message.to_vec(),
            ed25519_index: 0,
            payment_token: payment_token as u8,
            route,
        }
        .data();
        Instruction { program_id: laterite::ID, accounts, data }
    }

    /// The ed25519 instruction over the updates, then a sweep of what is due through the CPMM.
    pub fn sweep_ixs(&self, payment_token: usize, asset_message: &[u8], payment_message: &[u8]) -> Vec<Instruction> {
        let (route, accounts) = self.cpmm_route(payment_token, self.due(payment_token));
        vec![
            sweep_ed25519_ix(asset_message, payment_message),
            self.sweep_ix(payment_token, asset_message, payment_message, route, accounts),
        ]
    }

    /// A sweep of `payment_token` with updates composed at the clock's time.
    pub fn sweep_now(
        &mut self,
        payment_token: usize,
    ) -> (usize, Result<TransactionMetadata, FailedTransactionMetadata>) {
        let now = self.env.svm.get_sysvar::<Clock>().unix_timestamp;
        let (asset, payment) = composed_updates(payment_token, now);
        let instructions = self.sweep_ixs(payment_token, &asset, &payment);
        self.send(&instructions)
    }

    /// Sends `instructions` as one version 1 transaction from the crank; returns its size too.
    pub fn send(
        &mut self,
        instructions: &[Instruction],
    ) -> (usize, Result<TransactionMetadata, FailedTransactionMetadata>) {
        let config = v1::TransactionConfig {
            compute_unit_limit: Some(400_000),
            loaded_accounts_data_size_limit: Some(8 * 1024 * 1024),
            ..v1::TransactionConfig::default()
        };
        let blockhash = self.env.svm.latest_blockhash();
        let message =
            v1::Message::try_compile_with_config(&self.crank.pubkey(), instructions, blockhash, config).unwrap();
        let transaction = VersionedTransaction::try_new(VersionedMessage::V1(message), &[&self.crank]).unwrap();
        let size = transaction.message.serialize().len() + 1 + 64 * transaction.signatures.len();
        let result = self.env.svm.send_transaction(transaction);
        self.env.svm.expire_blockhash();
        (size, result)
    }
}

/// The `Swept` event a sweep emitted through its self-CPI.
pub fn swept(metadata: &TransactionMetadata) -> Swept {
    let prefix = [EVENT_IX_TAG_LE, Swept::DISCRIMINATOR].concat();
    let data = metadata
        .inner_instructions
        .iter()
        .flatten()
        .find_map(|inner| inner.instruction.data.strip_prefix(prefix.as_slice()))
        .unwrap();
    Swept::deserialize(&mut &data[..]).unwrap()
}

/// Compute units of the program's first top-level instruction in a transaction, its CPIs included, from the runtime's
/// `invoke` and `consumed` log lines.
pub fn program_units(metadata: &TransactionMetadata) -> u64 {
    let consumed = format!("Program {} consumed ", laterite::ID);
    let mut depth = 0;
    for line in &metadata.logs {
        if line.contains(" invoke [") {
            depth += 1;
        } else if line.ends_with(" success") || line.contains(" failed: ") {
            depth -= 1;
        } else if let Some(rest) = line.strip_prefix(&consumed).filter(|_| depth == 1) {
            return rest.split(' ').next().unwrap().parse().unwrap();
        }
    }
    panic!("the program did not run at the top level")
}

/// Compute units of each invocation of `program`, in the order they finished.
pub fn units_of(metadata: &TransactionMetadata, program: &Pubkey) -> Vec<u64> {
    let prefix = format!("Program {program} consumed ");
    metadata.logs.iter().filter_map(|line| line.strip_prefix(&prefix)?.split(' ').next()?.parse().ok()).collect()
}

/// The test router's data and accounts to run `instructions` in order: each account once, writable when any
/// instruction writes it, never a signer, since the sweep signs as the vault.
pub fn test_route(instructions: &[Instruction]) -> (Vec<u8>, Vec<AccountMeta>) {
    let mut accounts: Vec<AccountMeta> = vec![];
    let mut index = |pubkey: Pubkey, is_writable: bool| {
        let position = accounts.iter().position(|meta| meta.pubkey == pubkey).unwrap_or_else(|| {
            accounts.push(AccountMeta::new_readonly(pubkey, false));
            accounts.len() - 1
        });
        accounts[position].is_writable |= is_writable;
        position as u8
    };
    let mut data = vec![];
    for instruction in instructions {
        data.push(index(instruction.program_id, false));
        data.push(instruction.accounts.len() as u8);
        for meta in &instruction.accounts {
            data.push(index(meta.pubkey, meta.is_writable));
        }
        data.extend((instruction.data.len() as u16).to_le_bytes());
        data.extend(&instruction.data);
    }
    (data, accounts)
}

fn user_only(user: Pubkey) -> Vec<AccountMeta> {
    laterite::accounts::UserOnly { user, user_config: user_config_address(&user) }.to_account_metas(None)
}

pub fn update_settings_ix(user: Pubkey, params: EnrollParams) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: user_only(user),
        data: laterite::instruction::UpdateSettings { params }.data(),
    }
}

pub fn set_user_paused_ix(user: Pubkey, paused: bool) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: user_only(user),
        data: laterite::instruction::SetUserPaused { paused }.data(),
    }
}

pub fn lower_pending_ix(user: Pubkey, pending: u64) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: user_only(user),
        data: laterite::instruction::LowerPending { pending }.data(),
    }
}

/// The enabled payment tokens of a bitmask, in order.
pub fn enabled(payment_tokens: u8) -> impl Iterator<Item = usize> {
    (0..2).filter(move |token| payment_tokens & (1 << token) != 0)
}

/// What a subscription still lets its plan's owner pull in the current period at `now`, as a crank mirrors the
/// sweep's bound: 0 once it has expired or closed.
pub fn native_remaining(svm: &LiteSVM, subscription: &Pubkey, now: i64) -> u64 {
    let Some(account) = svm.get_account(subscription).filter(|account| account.owner == SUBSCRIPTIONS_ID) else {
        return 0;
    };
    let state = SubscriptionDelegation::from_bytes(&account.data).unwrap();
    if state.expires_at_ts != 0 && now >= state.expires_at_ts {
        0
    } else if now - state.current_period_start_ts >= state.terms.period_hours as i64 * 3_600 {
        state.terms.amount
    } else {
        state.terms.amount - state.amount_pulled_in_period
    }
}

fn cancellation(user: Pubkey) -> laterite::accounts::Cancellation {
    laterite::accounts::Cancellation {
        user,
        vault: vault_address(),
        subscriptions_program: SUBSCRIPTIONS_ID,
        subscriptions_event_authority: EventAuthority::find_pda().0,
    }
}

pub fn change_tier_ix(user: Pubkey, from: usize, tier: usize, payment_tokens: u8) -> Instruction {
    let mut accounts = laterite::accounts::TierChange {
        cancellation: cancellation(user),
        config: config_address(),
        user_config: user_config_address(&user),
    }
    .to_account_metas(None);
    for token in enabled(payment_tokens) {
        accounts.extend([
            AccountMeta::new_readonly(plan_address(token, from), false),
            AccountMeta::new(subscription_address(token, from, &user), false),
            AccountMeta::new_readonly(subscription_address(token, tier, &user), false),
        ]);
    }
    Instruction {
        program_id: laterite::ID,
        accounts,
        data: laterite::instruction::ChangeTier { tier: tier as u8 }.data(),
    }
}

pub fn change_payment_tokens_ix(user: Pubkey, tier: usize, from: u8, payment_tokens: u8) -> Instruction {
    let mut accounts = laterite::accounts::PaymentTokensChange {
        cancellation: cancellation(user),
        user_config: user_config_address(&user),
    }
    .to_account_metas(None);
    for token in 0..2 {
        let (was, is) = (from & (1 << token) != 0, payment_tokens & (1 << token) != 0);
        if was && !is {
            accounts.push(AccountMeta::new_readonly(plan_address(token, tier), false));
            accounts.push(AccountMeta::new(subscription_address(token, tier, &user), false));
        } else if is && !was {
            accounts.push(AccountMeta::new_readonly(subscription_address(token, tier, &user), false));
        }
    }
    let data = laterite::instruction::ChangePaymentTokens { payment_tokens }.data();
    Instruction { program_id: laterite::ID, accounts, data }
}

/// `revoke_delegation` of the user's ended subscription to a tier's plan, signed by the user; the rent returns to the
/// payer the subscription recorded.
pub fn close_subscription_ix(svm: &LiteSVM, user: Pubkey, payment_token: usize, tier: usize) -> Instruction {
    let subscription = subscription_address(payment_token, tier, &user);
    let payer = SubscriptionDelegation::from_bytes(&svm.get_account(&subscription).unwrap().data).unwrap().header.payer;
    RevokeDelegationBuilder::new()
        .authority(user)
        .delegation_account(subscription)
        .add_remaining_account(AccountMeta::new_readonly(plan_address(payment_token, tier), false))
        .add_remaining_account(AccountMeta::new(payer, false))
        .instruction()
}

/// `revoke_subscription_authority` for a token: the approval is revoked and the rent returns to the payer the
/// authority recorded.
pub fn revoke_authority_ix(svm: &LiteSVM, user: Pubkey, payment_token: usize) -> Instruction {
    let token = valid_params().payment_tokens[payment_token];
    let authority = SubscriptionAuthority::find_pda(&user, &token.mint).0;
    let payer = SubscriptionAuthority::from_bytes(&svm.get_account(&authority).unwrap().data).unwrap().payer;
    RevokeSubscriptionAuthorityBuilder::new()
        .user(user)
        .user_ata(ata(&user, &token.mint, &token.token_program))
        .token_mint(token.mint)
        .token_program(token.token_program)
        .subscription_authority(authority)
        .receiver(Some(payer))
        .instruction()
}

/// A tier change as the app sends it, sponsored: subscribe to the new tier's plans, `change_tier`, then close the
/// ended subscriptions.
pub fn change_tier_ixs(svm: &LiteSVM, user: Pubkey, tier: usize) -> Vec<Instruction> {
    let user_config =
        UserConfig::try_deserialize(&mut &svm.get_account(&user_config_address(&user)).unwrap().data[..]).unwrap();
    let from = usize::from(user_config.tier);
    let tokens = || enabled(user_config.payment_tokens);
    let mut instructions: Vec<_> =
        tokens().flat_map(|token| subscribe_ixs(svm, user, sponsor().pubkey(), token, tier)).collect();
    instructions.push(change_tier_ix(user, from, tier, user_config.payment_tokens));
    instructions.extend(tokens().map(|token| close_subscription_ix(svm, user, token, from)));
    instructions
}

/// A payment-token change as the app sends it, sponsored: subscribe with each added token, `change_payment_tokens`,
/// then close each dropped token's subscription and revoke its authority. The app revokes an authority only when the
/// user has no other live subscription with that token, since the approval is per token, not per merchant.
pub fn change_payment_tokens_ixs(svm: &LiteSVM, user: Pubkey, payment_tokens: u8) -> Vec<Instruction> {
    let user_config =
        UserConfig::try_deserialize(&mut &svm.get_account(&user_config_address(&user)).unwrap().data[..]).unwrap();
    let (tier, from) = (usize::from(user_config.tier), user_config.payment_tokens);
    let mut instructions: Vec<_> = enabled(payment_tokens & !from)
        .flat_map(|token| subscribe_ixs(svm, user, sponsor().pubkey(), token, tier))
        .collect();
    instructions.push(change_payment_tokens_ix(user, tier, from, payment_tokens));
    for token in enabled(from & !payment_tokens) {
        instructions.push(close_subscription_ix(svm, user, token, tier));
        instructions.push(revoke_authority_ix(svm, user, token));
    }
    instructions
}

pub fn exit_ix(user: Pubkey, tier: usize, payment_tokens: u8) -> Instruction {
    let mut accounts = laterite::accounts::Exit {
        cancellation: cancellation(user),
        config: config_address(),
        user_config: user_config_address(&user),
    }
    .to_account_metas(None);
    for token in enabled(payment_tokens) {
        accounts.extend([
            AccountMeta::new_readonly(plan_address(token, tier), false),
            AccountMeta::new(subscription_address(token, tier, &user), false),
        ]);
    }
    Instruction { program_id: laterite::ID, accounts, data: laterite::instruction::Exit {}.data() }
}

/// An exit as the app sends it, sponsored: `exit`, then close the subscriptions and revoke the authorities, each rent
/// returning to whoever paid it. The app revokes an authority only when the user has no other live subscription with
/// that token.
pub fn exit_ixs(svm: &LiteSVM, user: Pubkey) -> Vec<Instruction> {
    let user_config =
        UserConfig::try_deserialize(&mut &svm.get_account(&user_config_address(&user)).unwrap().data[..]).unwrap();
    let tier = usize::from(user_config.tier);
    let tokens = || enabled(user_config.payment_tokens);
    let mut instructions = vec![exit_ix(user, tier, user_config.payment_tokens)];
    instructions.extend(tokens().map(|token| close_subscription_ix(svm, user, token, tier)));
    instructions.extend(tokens().map(|token| revoke_authority_ix(svm, user, token)));
    instructions
}

pub fn reactivate_ix(user: Pubkey, sponsor: Pubkey, params: EnrollParams) -> Instruction {
    let mut accounts = laterite::accounts::Reactivate {
        user,
        sponsor,
        config: config_address(),
        user_config: user_config_address(&user),
    }
    .to_account_metas(None);
    let tier = usize::from(params.tier);
    accounts.extend(
        enabled(params.payment_tokens)
            .map(|token| AccountMeta::new_readonly(subscription_address(token, tier, &user), false)),
    );
    Instruction { program_id: laterite::ID, accounts, data: laterite::instruction::Reactivate { params }.data() }
}

/// A return as the app sends it, sponsored like onboarding: the asset's account, then per enabled token the authority
/// when it was revoked and the subscription, then `reactivate`.
pub fn reactivation_ixs(svm: &LiteSVM, user: Pubkey, params: &EnrollParams) -> Vec<Instruction> {
    let sponsor = sponsor().pubkey();
    let asset = valid_params().assets[usize::from(params.asset)];
    let mut instructions = vec![create_ata_ix(sponsor, user, asset.mint, asset.token_program)];
    let tier = usize::from(params.tier);
    instructions
        .extend(enabled(params.payment_tokens).flat_map(|token| subscribe_ixs(svm, user, sponsor, token, tier)));
    instructions.push(reactivate_ix(user, sponsor, params.clone()));
    instructions
}
