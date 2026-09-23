//! The program tests' `tests/common`, ported to Crucible's LiteSVM.

use crucible_fuzzer::anchor_lang::{
    solana_program::instruction::{AccountMeta, Instruction},
    system_program, AnchorSerialize, InstructionData, ToAccountMetas,
};
use crucible_fuzzer::{AccountBuilderBase, TestContext};
use laterite::{
    plan_id, Asset, Attestation, ConfigParams, EnrollParams, PaymentToken, Quote, Settings, ATTESTATION_DOMAIN,
    ATTESTATION_SEED, CONFIG, PLANS, PLAN_PERIOD_HOURS, SWAP_AUTHORITY, TIERS, USER_CONFIG_SEED, VAULT,
};
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use subscriptions::{
    instructions::{
        CancelSubscriptionBuilder, DeletePlanBuilder, InitSubscriptionAuthorityBuilder, RevokeDelegationBuilder,
        SubscribeBuilder, TransferSubscriptionBuilder, UpdatePlanBuilder,
    },
    types::{SubscribeData, TransferData, UpdatePlanData},
    EventAuthority, Plan, SubscriptionAuthority, SubscriptionDelegation, SUBSCRIPTIONS_ID,
};

use crate::constants::*;

pub fn keypair(seed: u8) -> Keypair {
    Keypair::new_from_array([seed; 32])
}

pub fn set_clock(ctx: &mut TestContext, ts: i64) {
    let slot = ((ts - SETUP_TS).max(0) * SLOTS_PER_SECOND) as u64 + 1;
    ctx.warp_to_slot(slot);
    ctx.set_sysvar(&Clock {
        slot,
        epoch_start_timestamp: SETUP_TS,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: ts,
    });
}

pub fn now(ctx: &TestContext) -> i64 {
    ctx.svm.get_sysvar::<Clock>().unix_timestamp
}

pub fn fund(ctx: &mut TestContext, address: &Pubkey) {
    ctx.create_account().pubkey(*address).lamports(LAMPORTS).owner(system_program::ID).create().unwrap();
}

/// Writes the committed copy of a devnet account.
pub fn load_devnet_account(ctx: &mut TestContext, address: Pubkey, owner: Pubkey) {
    let data = std::fs::read(format!("{FIXTURES}/devnet/{address}.bin")).unwrap();
    let lamports = ctx.svm.minimum_balance_for_rent_exemption(data.len());
    ctx.write_account(&address, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
}

pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

pub fn payment_account(owner: &Pubkey, token: usize) -> Pubkey {
    ata(owner, &PAYMENT_MINTS[token], &TOKEN)
}

pub fn asset_account(owner: &Pubkey, asset: usize) -> Pubkey {
    ata(owner, &ASSETS[asset], &TOKEN_2022)
}

/// The swap authority's token accounts, payment tokens then assets, and the account a route could initialize for it.
pub fn swap_accounts() -> [Pubkey; 5] {
    [
        payment_account(&SWAP_AUTHORITY, 0),
        payment_account(&SWAP_AUTHORITY, 1),
        asset_account(&SWAP_AUTHORITY, 0),
        asset_account(&SWAP_AUTHORITY, 1),
        FRESH,
    ]
}

pub fn token_amount(ctx: &TestContext, address: &Pubkey) -> u64 {
    ctx.get_account(address)
        .ok()
        .and_then(|account| Some(u64::from_le_bytes(account.data.get(64..72)?.try_into().ok()?)))
        .unwrap_or(0)
}

pub fn write_amount(ctx: &mut TestContext, address: &Pubkey, amount: u64) {
    ctx.update_account(address, |data| data[64..72].copy_from_slice(&amount.to_le_bytes())).unwrap();
}

/// An initialized SPL token account without extensions.
pub fn write_token_account(ctx: &mut TestContext, address: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
    let mut data = vec![0; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    ctx.write_account(&address, Account { lamports: 2_039_280, data, owner: TOKEN, executable: false, rent_epoch: 0 })
        .unwrap();
}

/// Prices `pool` at `price` per whole asset token, `bps` above it, with its accrued fees cleared.
pub fn peg(ctx: &mut TestContext, pool: &Pool, price: Quote, bps: i64) {
    ctx.update_account(&pool.address, |data| {
        for offset in [341, 349, 357, 365, 397, 405] {
            data[offset..offset + 8].fill(0);
        }
    })
    .unwrap();
    let worth = u128::from(POOL_DEPTH) * u128::from(price.price) / 10u128.pow(10);
    let payment = worth * (10_000 + bps) as u128 / 10_000;
    write_amount(ctx, &pool.asset_vault, POOL_DEPTH);
    write_amount(ctx, &pool.payment_vault, payment as u64);
}

/// Adds `signer` to Pyth Pro's storage as a trusted key: the count at 80, then 40-byte slots of key and expiry.
pub fn trust(ctx: &mut TestContext, signer: &Pubkey) {
    ctx.update_account(&PYTH_STORAGE, |data| {
        let slot = 81 + 40 * usize::from(data[80]);
        data[80] += 1;
        data[slot..slot + 32].copy_from_slice(signer.as_ref());
        data[slot + 32..slot + 40].copy_from_slice(&i64::MAX.to_le_bytes());
    })
    .unwrap();
}

/// A Solana-format Pyth Pro update of `feeds` published at `at`, signed by `signer`.
pub fn pyth_update(signer: &Keypair, at: i64, feeds: &[(u32, Quote)]) -> Vec<u8> {
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
    message.extend(signer.sign_message(&payload).as_ref());
    message.extend(signer.pubkey().as_ref());
    message.extend((payload.len() as u16).to_le_bytes());
    message.extend(payload);
    message
}

/// The ed25519 instruction Pyth Pro checks, one signature entry per update: the update, the index of the instruction
/// whose data holds it and its offset there.
pub fn pyth_ed25519_ix(updates: &[(&[u8], u16)]) -> Instruction {
    const ENVELOPE: u16 = 4 + 64 + 32 + 2;
    let mut data = vec![updates.len() as u8, 0];
    for &(message, offset) in updates {
        let index = 1u16;
        let offsets =
            [offset + 4, index, offset + 68, index, offset + ENVELOPE, message.len() as u16 - ENVELOPE, index];
        data.extend(offsets.iter().flat_map(|value| value.to_le_bytes()));
    }
    Instruction { program_id: ED25519_PROGRAM, accounts: vec![], data }
}

/// The ed25519 instruction in its standard single-signature layout: `signer`'s signature over `message`.
pub fn signature_ix(message: &[u8], signer: &Keypair) -> Instruction {
    let signature = signer.sign_message(message).into();
    solana_ed25519_program::new_ed25519_instruction_with_signature(message, &signature, &signer.pubkey().to_bytes())
}

pub fn params(attestor: Pubkey, sponsor: Pubkey) -> ConfigParams {
    let asset = |mint, pyth_feed_id| Asset { mint, token_program: TOKEN_2022, decimals: 8, pyth_feed_id };
    let payment = |mint, usd_feed_id| PaymentToken { mint, token_program: TOKEN, decimals: 6, usd_feed_id };
    ConfigParams {
        settings: Settings { attestor, sponsor, user_weekly_cap: 25_000_000, max_users: 100 },
        assets: [asset(SPYX, FEEDS[0]), asset(QQQX, FEEDS[1])],
        payment_tokens: [payment(USDC, 0), payment(USDT, USDT_FEED)],
        genesis_hash: DEVNET_GENESIS_HASH,
        router: ROUTER,
    }
}

pub fn program_data_address() -> Pubkey {
    let loader = crucible_fuzzer::anchor_lang::solana_program::bpf_loader_upgradeable::ID;
    Pubkey::find_program_address(&[laterite::ID.as_ref()], &loader).0
}

pub fn initialize_ix(authority: Pubkey, params: ConfigParams) -> Instruction {
    let mut accounts = laterite::accounts::Initialize {
        authority,
        config: CONFIG,
        program_data: program_data_address(),
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts.extend(ASSETS.iter().chain(&PAYMENT_MINTS).map(|mint| AccountMeta::new_readonly(*mint, false)));
    Instruction { program_id: laterite::ID, accounts, data: laterite::instruction::Initialize { params }.data() }
}

pub fn create_plan_ix(admin: Pubkey, token: usize, tier: usize) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: laterite::accounts::CreatePlan {
            admin,
            config: CONFIG,
            vault: VAULT,
            plan: PLANS[token][tier],
            mint: PAYMENT_MINTS[token],
            token_program: TOKEN,
            system_program: system_program::ID,
            subscriptions_program: SUBSCRIPTIONS_ID,
        }
        .to_account_metas(None),
        data: laterite::instruction::CreatePlan { payment_token: token as u8, tier: tier as u8 }.data(),
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

pub fn user_config_address(user: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[USER_CONFIG_SEED, user.as_ref()], &laterite::ID).0
}

pub fn subscription_address(token: usize, tier: usize, user: &Pubkey) -> Pubkey {
    SubscriptionDelegation::find_pda(&PLANS[token][tier], user).0
}

pub fn authority_address(user: &Pubkey, token: usize) -> Pubkey {
    SubscriptionAuthority::find_pda(user, &PAYMENT_MINTS[token]).0
}

pub fn init_authority_ix(user: Pubkey, payer: Pubkey, token: usize) -> Instruction {
    InitSubscriptionAuthorityBuilder::new()
        .owner(user)
        .subscription_authority(authority_address(&user, token))
        .token_mint(PAYMENT_MINTS[token])
        .user_ata(payment_account(&user, token))
        .token_program(TOKEN)
        .payer(Some(payer))
        .instruction()
}

/// `subscribe` to the tier's plan through the user's authority for the token: the stored `init_id`, or the
/// same-slot sentinel when the authority is created in the same transaction.
pub fn subscribe_ix(ctx: &TestContext, user: Pubkey, payer: Pubkey, token: usize, tier: usize) -> Instruction {
    let plan = PLANS[token][tier];
    let (_, plan_bump) = Plan::find_pda(&VAULT, plan_id(token, tier));
    let created_at = Plan::from_bytes(&ctx.get_account(&plan).unwrap().data).unwrap().data.terms.created_at;
    let init_id = ctx
        .get_account(&authority_address(&user, token))
        .ok()
        .and_then(|account| SubscriptionAuthority::from_bytes(&account.data).ok().map(|a| a.init_id))
        .unwrap_or(UNKNOWN_INIT_ID);
    SubscribeBuilder::new()
        .subscriber(user)
        .merchant(VAULT)
        .plan_pda(plan)
        .subscription_pda(subscription_address(token, tier, &user))
        .subscription_authority_pda(authority_address(&user, token))
        .event_authority(EventAuthority::find_pda().0)
        .payer(Some(payer))
        .subscribe_data(SubscribeData {
            plan_id: plan_id(token, tier),
            plan_bump,
            expected_mint: PAYMENT_MINTS[token],
            expected_amount: TIERS[tier],
            expected_period_hours: PLAN_PERIOD_HOURS,
            expected_created_at: created_at,
            expected_subscription_authority_init_id: init_id,
        })
        .instruction()
}

/// Subscriptions-side cancellation by the user: the subscription ends with its current period.
pub fn cancel_subscription_ix(user: Pubkey, token: usize, tier: usize) -> Instruction {
    CancelSubscriptionBuilder::new()
        .subscriber(user)
        .plan_pda(PLANS[token][tier])
        .subscription_pda(subscription_address(token, tier, &user))
        .event_authority(EventAuthority::find_pda().0)
        .instruction()
}

/// `revoke_delegation` of an ended subscription; the rent returns to the payer it recorded.
pub fn close_subscription_ix(ctx: &TestContext, user: Pubkey, token: usize, tier: usize) -> Option<Instruction> {
    let subscription = subscription_address(token, tier, &user);
    let payer = SubscriptionDelegation::from_bytes(&ctx.get_account(&subscription).ok()?.data).ok()?.header.payer;
    Some(
        RevokeDelegationBuilder::new()
            .authority(user)
            .delegation_account(subscription)
            .add_remaining_account(AccountMeta::new_readonly(PLANS[token][tier], false))
            .add_remaining_account(AccountMeta::new(payer, false))
            .instruction(),
    )
}

/// What a subscription still lets its plan's owner pull in the current period at `now`, mirrored from its fields as a
/// crank does: 0 once it has expired, or when the account holds no subscription.
pub fn native_remaining(data: Option<&[u8]>, now: i64) -> u64 {
    let Some(state) = data.and_then(|data| SubscriptionDelegation::from_bytes(data).ok()) else {
        return 0;
    };
    let period = state.terms.period_hours.saturating_mul(3_600);
    if state.expires_at_ts != 0 && now >= state.expires_at_ts {
        0
    } else if u64::try_from(now.saturating_sub(state.current_period_start_ts)).is_ok_and(|elapsed| elapsed >= period) {
        state.terms.amount
    } else {
        state.terms.amount.saturating_sub(state.amount_pulled_in_period)
    }
}

/// Whether a subscription can still be pulled at `now`: not expired, whatever the period allows.
pub fn pullable(data: Option<&[u8]>, now: i64) -> bool {
    data.and_then(|data| SubscriptionDelegation::from_bytes(data).ok())
        .is_some_and(|state| state.expires_at_ts == 0 || now < state.expires_at_ts)
}

pub fn enabled(payment_tokens: u8) -> impl Iterator<Item = usize> {
    (0..2).filter(move |token| payment_tokens & (1 << token) != 0)
}

pub fn enroll_ix(user: Pubkey, payer: Pubkey, params: EnrollParams) -> Instruction {
    let mut accounts = laterite::accounts::Enroll {
        user,
        payer,
        config: CONFIG,
        user_config: user_config_address(&user),
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    let tier = usize::from(params.tier) % TIERS.len();
    accounts.extend(
        enabled(params.payment_tokens)
            .map(|token| AccountMeta::new_readonly(subscription_address(token, tier, &user), false)),
    );
    Instruction { program_id: laterite::ID, accounts, data: laterite::instruction::Enroll { params }.data() }
}

/// `reactivate` naming `sponsor`, which signs only when `signs`.
pub fn reactivate_ix(user: Pubkey, sponsor: Pubkey, signs: bool, params: EnrollParams) -> Instruction {
    let mut accounts =
        laterite::accounts::Reactivate { user, sponsor, config: CONFIG, user_config: user_config_address(&user) }
            .to_account_metas(None);
    accounts[1].is_signer = signs;
    let tier = usize::from(params.tier) % TIERS.len();
    accounts.extend(
        enabled(params.payment_tokens)
            .map(|token| AccountMeta::new_readonly(subscription_address(token, tier, &user), false)),
    );
    Instruction { program_id: laterite::ID, accounts, data: laterite::instruction::Reactivate { params }.data() }
}

pub fn record_address(attestation: &Attestation) -> Pubkey {
    let seeds: &[&[u8]] = &[
        ATTESTATION_SEED,
        attestation.user.as_ref(),
        &attestation.signature[..32],
        &attestation.signature[32..],
        &attestation.transfer_index.to_le_bytes(),
    ];
    Pubkey::find_program_address(seeds, &laterite::ID).0
}

/// What the attestor signs for `attestation` in the deployment of `program` on the cluster with `genesis_hash`.
pub fn attestation_message(program: &Pubkey, genesis_hash: &[u8; 32], attestation: &Attestation) -> Vec<u8> {
    let mut message = [ATTESTATION_DOMAIN, program.as_ref(), genesis_hash].concat();
    attestation.serialize(&mut message).unwrap();
    message
}

pub fn attest_ix(payer: Pubkey, attestation: &Attestation) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: laterite::accounts::Attest {
            payer,
            config: CONFIG,
            user_config: user_config_address(&attestation.user),
            record: record_address(attestation),
            instructions: INSTRUCTIONS_SYSVAR,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: laterite::instruction::Attest { attestation: attestation.clone() }.data(),
    }
}

pub fn close_attestation_ix(record: Pubkey, payer: Pubkey) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: laterite::accounts::CloseAttestation { record, payer }.to_account_metas(None),
        data: laterite::instruction::CloseAttestation {}.data(),
    }
}

/// `swap_base_input` on `pool` from `input` into `output`, the swap authority as taker, with no minimum of its own.
pub fn cpmm_swap_ix(pool: &Pool, input: Pubkey, output: Pubkey, amount_in: u64) -> Instruction {
    let authority = Pubkey::find_program_address(&[b"vault_and_lp_mint_auth_seed"], &CPMM).0;
    let accounts = vec![
        AccountMeta::new_readonly(SWAP_AUTHORITY, false),
        AccountMeta::new_readonly(authority, false),
        AccountMeta::new_readonly(CPMM_CONFIG, false),
        AccountMeta::new(pool.address, false),
        AccountMeta::new(input, false),
        AccountMeta::new(output, false),
        AccountMeta::new(pool.payment_vault, false),
        AccountMeta::new(pool.asset_vault, false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(TOKEN_2022, false),
        AccountMeta::new_readonly(pool.payment_mint, false),
        AccountMeta::new_readonly(pool.asset_mint, false),
        AccountMeta::new(pool.observation, false),
    ];
    let mut data = vec![143, 190, 90, 218, 196, 30, 51, 222];
    data.extend(amount_in.to_le_bytes());
    data.extend(0u64.to_le_bytes());
    Instruction { program_id: CPMM, accounts, data }
}

/// The router's data and accounts to run `instructions` in order: each account once, writable when any instruction
/// writes it, never a signer, since the sweep signs as the swap authority.
pub fn route(instructions: &[Instruction]) -> (Vec<u8>, Vec<AccountMeta>) {
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

/// A pull of `amount` from `subscriber`'s USDC subscription to the $10 plan, `caller` signing as the puller, into the
/// swap authority's USDC account.
pub fn transfer_subscription_ix(subscriber: Pubkey, caller: Pubkey, amount: u64) -> Instruction {
    TransferSubscriptionBuilder::new()
        .subscription_pda(subscription_address(0, 0, &subscriber))
        .plan_pda(PLANS[0][0])
        .subscription_authority(authority_address(&subscriber, 0))
        .delegator_ata(payment_account(&subscriber, 0))
        .receiver_ata(payment_account(&SWAP_AUTHORITY, 0))
        .caller(caller)
        .token_mint(USDC)
        .token_program(TOKEN)
        .event_authority(EventAuthority::find_pda().0)
        .transfer_data(TransferData { amount, delegator: subscriber, mint: USDC })
        .instruction()
}

/// The USDC $10 plan's pullers replaced by `puller`, signed by `owner`.
pub fn update_plan_ix(ctx: &TestContext, owner: Pubkey, puller: Pubkey) -> Instruction {
    let plan = PLANS[0][0];
    let data = Plan::from_bytes(&ctx.get_account(&plan).unwrap().data).unwrap().data;
    UpdatePlanBuilder::new()
        .owner(owner)
        .plan_pda(plan)
        .event_authority(EventAuthority::find_pda().0)
        .update_plan_data(UpdatePlanData {
            status: 1,
            end_ts: data.end_ts,
            pullers: [puller, Pubkey::default(), Pubkey::default(), Pubkey::default()],
            metadata_uri: data.metadata_uri,
            expected_created_at: data.terms.created_at,
            expected_end_ts: data.end_ts,
            expected_pullers: data.pullers,
            expected_metadata_uri: data.metadata_uri,
        })
        .instruction()
}

pub fn delete_plan_ix(owner: Pubkey) -> Instruction {
    DeletePlanBuilder::new().owner(owner).plan_pda(PLANS[0][0]).instruction()
}

#[allow(clippy::too_many_arguments)]
pub fn sweep_ix(
    crank: Pubkey,
    user: Pubkey,
    token: usize,
    tier: usize,
    asset: usize,
    asset_message: &[u8],
    payment_message: &[u8],
    route: Vec<u8>,
    route_accounts: Vec<AccountMeta>,
) -> Instruction {
    let mut accounts = laterite::accounts::Sweep {
        crank,
        config: CONFIG,
        user_config: user_config_address(&user),
        vault: VAULT,
        subscription: subscription_address(token, tier, &user),
        plan: PLANS[token][tier],
        subscription_authority: authority_address(&user, token),
        user_payment_account: payment_account(&user, token),
        swap_payment_account: payment_account(&SWAP_AUTHORITY, token),
        user_asset_account: asset_account(&user, asset),
        payment_mint: PAYMENT_MINTS[token],
        payment_token_program: TOKEN,
        subscriptions_program: SUBSCRIPTIONS_ID,
        subscriptions_event_authority: EventAuthority::find_pda().0,
        swap_authority: SWAP_AUTHORITY,
        router: ROUTER,
        pyth_program: PYTH_PRO,
        pyth_storage: PYTH_STORAGE,
        pyth_treasury: PYTH_TREASURY,
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
        payment_token: token as u8,
        route,
    }
    .data();
    Instruction { program_id: laterite::ID, accounts, data }
}

/// A `UserOnly` instruction signed by `user` on `user_config`, which may belong to someone else.
pub fn user_only_ix(user: Pubkey, user_config: Pubkey, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: laterite::accounts::UserOnly { user, user_config }.to_account_metas(None),
        data,
    }
}

fn cancellation(user: Pubkey) -> laterite::accounts::Cancellation {
    laterite::accounts::Cancellation {
        user,
        vault: VAULT,
        subscriptions_program: SUBSCRIPTIONS_ID,
        subscriptions_event_authority: EventAuthority::find_pda().0,
    }
}

pub fn change_tier_ix(user: Pubkey, from: usize, tier: usize, payment_tokens: u8) -> Instruction {
    let mut accounts = laterite::accounts::TierChange {
        cancellation: cancellation(user),
        config: CONFIG,
        user_config: user_config_address(&user),
    }
    .to_account_metas(None);
    for token in enabled(payment_tokens) {
        accounts.extend([
            AccountMeta::new_readonly(PLANS[token][from], false),
            AccountMeta::new(subscription_address(token, from, &user), false),
            AccountMeta::new_readonly(subscription_address(token, tier % TIERS.len(), &user), false),
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
            accounts.push(AccountMeta::new_readonly(PLANS[token][tier], false));
            accounts.push(AccountMeta::new(subscription_address(token, tier, &user), false));
        } else if is && !was {
            accounts.push(AccountMeta::new_readonly(subscription_address(token, tier, &user), false));
        }
    }
    let data = laterite::instruction::ChangePaymentTokens { payment_tokens }.data();
    Instruction { program_id: laterite::ID, accounts, data }
}

pub fn exit_ix(user: Pubkey, tier: usize, payment_tokens: u8) -> Instruction {
    let mut accounts = laterite::accounts::Exit {
        cancellation: cancellation(user),
        config: CONFIG,
        user_config: user_config_address(&user),
    }
    .to_account_metas(None);
    for token in enabled(payment_tokens) {
        accounts.extend([
            AccountMeta::new_readonly(PLANS[token][tier], false),
            AccountMeta::new(subscription_address(token, tier, &user), false),
        ]);
    }
    Instruction { program_id: laterite::ID, accounts, data: laterite::instruction::Exit {}.data() }
}

pub fn admin_ix(admin: Pubkey, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: laterite::accounts::AdminOnly { admin, config: CONFIG }.to_account_metas(None),
        data,
    }
}

pub fn accept_admin_ix(pending_admin: Pubkey) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: laterite::accounts::AcceptAdmin { pending_admin, config: CONFIG }.to_account_metas(None),
        data: laterite::instruction::AcceptAdmin {}.data(),
    }
}

/// Days from 1970-01-01 to a `YYYY-MM-DD` date.
fn day(date: &str) -> u16 {
    let parts: Vec<i64> = date.split('-').map(|part| part.parse().unwrap()).collect();
    let (year, month, day) = (parts[0], parts[1], parts[2]);
    let leap = |y: i64| y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let years: i64 = (1970..year).map(|y| if leap(y) { 366 } else { 365 }).sum();
    let lengths = [31, if leap(year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let months: i64 = lengths[..month as usize - 1].iter().sum();
    (years + months + day - 1) as u16
}

/// The NYSE calendar the deployment loads, as `set_market_calendar` takes it: holidays, early closes and the last day
/// covered, in days since 1970-01-01.
pub fn nyse_calendar() -> (Vec<u16>, Vec<u16>, u16) {
    let file: crucible_fuzzer::serde_json::Value =
        crucible_fuzzer::serde_json::from_str(&std::fs::read_to_string(NYSE_CALENDAR).unwrap()).unwrap();
    let days = |key: &str| file[key].as_array().unwrap().iter().map(|date| day(date.as_str().unwrap())).collect();
    (days("holidays"), days("earlyCloses"), day(file["validThrough"].as_str().unwrap()))
}
