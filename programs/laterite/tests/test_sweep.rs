mod common;

use {
    anchor_lang::solana_program::{
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
    },
    anchor_spl::{
        token::{self, spl_token::instruction as token_instruction},
        token_2022::{
            self,
            spl_token_2022::{
                extension::{memo_transfer::instruction::enable_required_transfer_memos, ExtensionType},
                instruction as token_2022_instruction,
            },
        },
    },
    common::*,
    laterite::{
        min_out, Engine, EnrollParams, LateriteError, MarketCalendar, Quote, Settings, UserStatus, DAY_SECONDS,
        SWAP_AUTHORITY, TRIAL_CAP, USD_DECIMALS,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_signer::Signer,
    solana_transaction::{InstructionError, TransactionError},
    subscriptions::{
        errors::SubscriptionsError, instructions::TransferSubscriptionBuilder, types::TransferData, EventAuthority,
        SubscriptionAuthority,
    },
};

const DOLLAR: u64 = 1_000_000;
const USDC_TOKEN: usize = 0;
const USDT_TOKEN: usize = 1;
/// Tuesday 2026-09-22 at 14:00 UTC, 10:00 in New York: inside a regular session.
const IN_SESSION: i64 = 1_790_085_600;

/// A daily engine of $1 into SPYx, paying with both tokens.
fn params() -> EnrollParams {
    default_enroll_params()
}

fn with_pending(sweep: &mut SweepEnv, pending: u64) {
    let mut user_config = fetch_user_config(&sweep.env, &sweep.user.pubkey());
    user_config.pending = pending;
    write_user_config(&mut sweep.env, &user_config);
}

/// The real updates a sweep of `payment_token` carries: Kamino's SPYX/QQQX update and, for USDT, the USDT update.
fn real_updates(payment_token: usize) -> (&'static [u8], &'static [u8]) {
    (PYTH_SPYX_QQQX, if payment_token == USDT_TOKEN { PYTH_USDT } else { &[] })
}

/// Sweeps `payment_token` with the real updates.
fn sweep_real(sweep: &mut SweepEnv, payment_token: usize) -> SweptOutcome {
    let (asset, payment) = real_updates(payment_token);
    let instructions = sweep.sweep_ixs(payment_token, asset, payment);
    sweep.send(&instructions)
}

type SweptOutcome = (usize, Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>);

fn error_of(outcome: SweptOutcome) -> Option<u32> {
    custom_code(&outcome.1.unwrap_err())
}

#[test]
fn a_usdc_sweep_verifies_the_asset_update_and_buys_at_least_the_minimum() {
    for (cluster, pyth) in &PYTH_DEPLOYMENTS {
        let mut sweep = sweep_env_with(pyth, CPMM, &params());
        with_pending(&mut sweep, 3 * DOLLAR);
        let before = token_amount(&sweep.env.svm, &sweep.user_payment_account(USDC_TOKEN));
        let treasury = sweep.env.svm.get_balance(&pyth.treasury).unwrap();
        assert_eq!(sweep.due(USDC_TOKEN), 4 * DOLLAR);

        let (size, result) = sweep_real(&mut sweep, USDC_TOKEN);
        let metadata = result.unwrap();
        let event = swept(&metadata);
        println!(
            "{cluster}: USDC sweep {size} B, {} CU (Pyth Pro {:?}), fee {} lamports",
            metadata.compute_units_consumed,
            units_of(&metadata, &PYTH_PRO_ID),
            metadata.fee
        );

        assert_eq!(units_of(&metadata, &PYTH_PRO_ID).len(), 1, "one verification");
        assert_eq!(sweep.env.svm.get_balance(&pyth.treasury).unwrap(), treasury + 1);
        assert_eq!((event.engine, event.pending), (DOLLAR, 3 * DOLLAR));
        assert_eq!(event.asset_price, PYTH_SPYX_QUOTE.price);
        let minimum = min_out(4 * DOLLAR, Quote::DOLLAR, USD_DECIMALS, PYTH_SPYX_QUOTE, 8).unwrap();
        assert_eq!(event.min_out, minimum);
        assert!(event.received >= event.min_out);
        assert_eq!(event.received, token_amount(&sweep.env.svm, &sweep.user_asset_account()));
        assert_eq!(token_amount(&sweep.env.svm, &sweep.user_payment_account(USDC_TOKEN)), before - 4 * DOLLAR);
        assert_eq!(token_amount(&sweep.env.svm, &sweep.swap_payment_account(USDC_TOKEN)), 0);
        let user_config = fetch_user_config(&sweep.env, &sweep.user.pubkey());
        assert_eq!((user_config.week_spent, user_config.pending), (4 * DOLLAR, 0));
        assert_eq!(user_config.engine_ran_at, PYTH_UPDATES_AT);
        assert_eq!(user_config.last_sweep_day, [(PYTH_UPDATES_AT / DAY_SECONDS) as u32, 0]);
    }
}

#[test]
fn a_usdt_sweep_verifies_both_real_updates_and_prices_usdt_from_its_own() {
    for (cluster, pyth) in &PYTH_DEPLOYMENTS {
        let mut sweep = sweep_env_with(pyth, CPMM, &params());
        let treasury = sweep.env.svm.get_balance(&pyth.treasury).unwrap();
        assert_eq!(sweep.due(USDT_TOKEN), DOLLAR);

        let (size, result) = sweep_real(&mut sweep, USDT_TOKEN);
        let metadata = result.unwrap();
        let event = swept(&metadata);
        println!(
            "{cluster}: USDT sweep {size} B, {} CU (Pyth Pro {:?}), fee {} lamports",
            metadata.compute_units_consumed,
            units_of(&metadata, &PYTH_PRO_ID),
            metadata.fee
        );

        // The payment update sits at 16 + the asset update's length in the sweep's data, verified under CPI.
        assert_eq!(units_of(&metadata, &PYTH_PRO_ID).len(), 2, "two verifications");
        assert_eq!(sweep.env.svm.get_balance(&pyth.treasury).unwrap(), treasury + 2);
        assert_eq!(event.payment_token, USDT_TOKEN as u8);
        let minimum = min_out(DOLLAR, PYTH_USDT_QUOTE, USD_DECIMALS, PYTH_SPYX_QUOTE, 8).unwrap();
        assert_eq!(event.min_out, minimum);
        assert!(minimum < min_out(DOLLAR, Quote::DOLLAR, USD_DECIMALS, PYTH_SPYX_QUOTE, 8).unwrap());
        assert!(event.received >= event.min_out);
        assert_eq!(token_amount(&sweep.env.svm, &sweep.swap_payment_account(USDT_TOKEN)), 0);
    }
}

#[test]
fn the_payment_update_is_the_tokens_own_and_must_verify() {
    let mut sweep = sweep_env(&params());
    let failure = sweep.send(&sweep.sweep_ixs(USDT_TOKEN, PYTH_SPYX_QQQX, &[])).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidPriceUpdate.into()));
    let failure = sweep.send(&sweep.sweep_ixs(USDC_TOKEN, PYTH_SPYX_QQQX, PYTH_USDT)).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidPriceUpdate.into()));

    // Each verification is bound to its own signature entry.
    let mut instructions = sweep.sweep_ixs(USDT_TOKEN, PYTH_SPYX_QQQX, PYTH_USDT);
    let payment_offset = 16 + PYTH_SPYX_QQQX.len() as u16;
    instructions[0] = ed25519_ix(&[(PYTH_USDT, 1, payment_offset), (PYTH_SPYX_QQQX, 1, 12)]);
    let failure = sweep.send(&instructions).1.unwrap_err();
    assert_eq!(failure.err, TransactionError::InstructionError(1, InstructionError::InvalidInstructionData));
    assert!(failure.meta.logs.iter().any(|line| line.contains("InvalidMessageData")));

    let untrusted = signed_by(PYTH_USDT, &Keypair::new());
    let failure = sweep.send(&sweep.sweep_ixs(USDT_TOKEN, PYTH_SPYX_QQQX, &untrusted)).1.unwrap_err();
    assert!(failure.meta.logs.iter().any(|line| line.contains("NotTrustedSigner")));

    let stale = pyth_update(PYTH_UPDATES_AT - 61, &[(8, PYTH_USDT_QUOTE)]);
    let failure = sweep.send(&sweep.sweep_ixs(USDT_TOKEN, PYTH_SPYX_QQQX, &stale)).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::StalePrice.into()));
    assert_eq!(fetch_user_config(&sweep.env, &sweep.user.pubkey()).last_sweep_day, [0; 2]);

    sweep_real(&mut sweep, USDT_TOKEN).1.unwrap();
}

#[test]
fn each_token_is_swept_once_per_utc_day() {
    let mut sweep = sweep_env(&params());
    sweep_real(&mut sweep, USDC_TOKEN).1.unwrap();
    assert_eq!(error_of(sweep_real(&mut sweep, USDC_TOKEN)), Some(LateriteError::AlreadySwept.into()));

    with_pending(&mut sweep, DOLLAR);
    sweep_real(&mut sweep, USDT_TOKEN).1.unwrap();
    assert_eq!(error_of(sweep_real(&mut sweep, USDT_TOKEN)), Some(LateriteError::AlreadySwept.into()));

    set_now(&mut sweep.env.svm, (PYTH_UPDATES_AT / DAY_SECONDS + 1) * DAY_SECONDS);
    sweep.sweep_now(USDC_TOKEN).1.unwrap();
}

#[test]
fn nothing_due_fails_before_any_call_without_spending_the_day() {
    let mut sweep = sweep_env(&params());
    let account = sweep.user_payment_account(USDC_TOKEN);
    let balance = token_amount(&sweep.env.svm, &account);
    // The balance sits at the cushion.
    write_amount(&mut sweep.env.svm, account, 20 * DOLLAR);
    let failure = sweep_real(&mut sweep, USDC_TOKEN).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::NothingToSweep.into()));
    assert!(!failure.meta.logs.iter().any(|line| line.contains(&PYTH_PRO_ID.to_string())));
    assert_eq!(fetch_user_config(&sweep.env, &sweep.user.pubkey()).last_sweep_day, [0; 2]);

    write_amount(&mut sweep.env.svm, account, balance);
    sweep_real(&mut sweep, USDC_TOKEN).1.unwrap();
}

#[test]
fn a_paused_or_exited_user_is_not_swept() {
    let mut sweep = sweep_env(&params());
    with_pending(&mut sweep, 3 * DOLLAR);
    let active = fetch_user_config(&sweep.env, &sweep.user.pubkey());
    let balance = token_amount(&sweep.env.svm, &sweep.user_payment_account(USDC_TOKEN));
    for status in [UserStatus::Paused, UserStatus::Exited] {
        write_user_config(&mut sweep.env, &laterite::UserConfig { status, ..active.clone() });
        let failure = sweep_real(&mut sweep, USDC_TOKEN).1.unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::NothingToSweep.into()));
        assert!(!failure.meta.logs.iter().any(|line| line.contains(&PYTH_PRO_ID.to_string())));
        let user_config = fetch_user_config(&sweep.env, &sweep.user.pubkey());
        assert_eq!((user_config.last_sweep_day, user_config.pending), ([0; 2], 3 * DOLLAR));
        assert_eq!(token_amount(&sweep.env.svm, &sweep.user_payment_account(USDC_TOKEN)), balance);
    }
    write_user_config(&mut sweep.env, &active);
    sweep_real(&mut sweep, USDC_TOKEN).1.unwrap();
}

#[test]
fn a_weekly_user_is_swept_only_in_a_nyse_session() {
    let mut sweep = sweep_env(&EnrollParams { engine: Engine::Weekly, ..params() });
    with_pending(&mut sweep, 2 * DOLLAR);
    // The real updates' time, 22:26 in New York, is outside the session: not even pending amounts are pulled.
    assert_eq!(error_of(sweep_real(&mut sweep, USDC_TOKEN)), Some(LateriteError::NothingToSweep.into()));

    // Thanksgiving at 10:00 New York time, and the next day at 13:30, after its 13:00 early close.
    let thanksgiving = i64::from(day((2026, 11, 26))) * DAY_SECONDS;
    for closed in [thanksgiving + 15 * 3_600, thanksgiving + DAY_SECONDS + 18 * 3_600 + 1_800] {
        set_now(&mut sweep.env.svm, closed);
        assert_eq!(error_of(sweep.sweep_now(USDC_TOKEN)), Some(LateriteError::NothingToSweep.into()));
    }

    // Without a calendar covering today, no weekly sweep at all.
    set_now(&mut sweep.env.svm, IN_SESSION);
    let loaded = fetch_config(&sweep.env.svm);
    write_config(&mut sweep.env, &laterite::Config { market_calendar: MarketCalendar::default(), ..loaded.clone() });
    assert_eq!(error_of(sweep.sweep_now(USDC_TOKEN)), Some(LateriteError::NothingToSweep.into()));
    assert_eq!(fetch_user_config(&sweep.env, &sweep.user.pubkey()).last_sweep_day, [0; 2]);

    write_config(&mut sweep.env, &loaded);
    let event = swept(&sweep.sweep_now(USDC_TOKEN).1.unwrap());
    assert_eq!((event.engine, event.pending), (DOLLAR, 2 * DOLLAR));
}

#[test]
fn a_qqqx_user_buys_qqqx_at_its_price() {
    let mut sweep = sweep_env(&EnrollParams { asset: 1, ..params() });
    let event = swept(&sweep_real(&mut sweep, USDC_TOKEN).1.unwrap());
    assert_eq!((event.asset, event.asset_price), (1, PYTH_QQQX_QUOTE.price));
    assert!(event.received >= event.min_out);
    assert_eq!(event.received, token_amount(&sweep.env.svm, &sweep.user_asset_account()));
}

#[test]
fn the_combined_cap_and_the_beta_cap_bound_the_pull() {
    let mut sweep = sweep_env(&params());
    with_pending(&mut sweep, 50 * DOLLAR);
    assert_eq!(sweep.due(USDC_TOKEN), TRIAL_CAP);

    let admin = sweep.env.authority.insecure_clone();
    let settings = Settings { user_weekly_cap: 2 * DOLLAR, ..valid_params().settings };
    send(&mut sweep.env.svm, &admin, update_config_ix(admin.pubkey(), settings), &[]).unwrap();
    assert_eq!(sweep.due(USDC_TOKEN), 2 * DOLLAR);
    let event = swept(&sweep_real(&mut sweep, USDC_TOKEN).1.unwrap());
    assert_eq!(event.engine + event.pending, 2 * DOLLAR);

    assert_eq!(error_of(sweep_real(&mut sweep, USDT_TOKEN)), Some(LateriteError::NothingToSweep.into()));
}

#[test]
fn only_the_users_plan_for_the_token_and_tier_is_pulled() {
    let mut sweep = sweep_env(&params());
    let user = sweep.user.pubkey();
    for (payment_token, tier) in [(USDC_TOKEN, 1), (USDT_TOKEN, 0)] {
        let mut instructions = sweep.sweep_ixs(USDC_TOKEN, PYTH_SPYX_QQQX, &[]);
        instructions[1].accounts[4].pubkey = subscription_address(payment_token, tier, &user);
        instructions[1].accounts[5].pubkey = plan_address(payment_token, tier);
        let failure = sweep.send(&instructions).1.unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::SubscriptionMismatch.into()));
    }
}

#[test]
fn only_the_configured_router_swaps() {
    let mut sweep = sweep_env(&params());
    let mut instructions = sweep.sweep_ixs(USDC_TOKEN, PYTH_SPYX_QQQX, &[]);
    instructions[1].accounts[15].pubkey = PYTH_PRO_ID;
    let failure = sweep.send(&instructions).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidRouter.into()));
}

#[test]
fn a_manipulated_pool_reverts_the_whole_sweep() {
    let mut sweep = sweep_env(&params());
    // The route's own minimum is 0: only the prices bound the fill.
    peg(&mut sweep.env.svm, pool(SPYX, USDC), PYTH_SPYX_QUOTE, 200);
    let balance = token_amount(&sweep.env.svm, &sweep.user_payment_account(USDC_TOKEN));
    assert_eq!(error_of(sweep_real(&mut sweep, USDC_TOKEN)), Some(LateriteError::SlippageExceeded.into()));
    assert_eq!(token_amount(&sweep.env.svm, &sweep.user_payment_account(USDC_TOKEN)), balance);
    assert_eq!(fetch_user_config(&sweep.env, &sweep.user.pubkey()).last_sweep_day, [0; 2]);

    peg(&mut sweep.env.svm, pool(SPYX, USDC), PYTH_SPYX_QUOTE, 50);
    sweep_real(&mut sweep, USDC_TOKEN).1.unwrap();
}

/// A sweep of USDC with the real update through a caller-built route.
fn routed(sweep: &SweepEnv, route: Vec<u8>, accounts: Vec<AccountMeta>) -> [Instruction; 2] {
    [sweep_ed25519_ix(PYTH_SPYX_QQQX, &[]), sweep.sweep_ix(USDC_TOKEN, PYTH_SPYX_QQQX, &[], route, accounts)]
}

#[test]
fn a_route_must_spend_the_pull_and_pay_the_user() {
    let mut sweep = sweep_env(&params());
    let due = sweep.due(USDC_TOKEN);
    let (route, accounts) = sweep.cpmm_route(USDC_TOKEN, due - 1);
    let failure = sweep.send(&routed(&sweep, route, accounts)).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::SwapAccountChanged.into()));

    let thief = funded(&mut sweep.env.svm);
    let token_2022 = anchor_spl::token_2022::ID;
    send(&mut sweep.env.svm, &thief, create_ata_ix(thief.pubkey(), thief.pubkey(), SPYX, token_2022), &[]).unwrap();
    let thief_account = ata(&thief.pubkey(), &SPYX, &token_2022);
    let (route, mut accounts) = sweep.cpmm_route(USDC_TOKEN, due);
    accounts[5] = AccountMeta::new(thief_account, false);
    let mut instructions = routed(&sweep, route, accounts);
    let failure = sweep.send(&instructions).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::SlippageExceeded.into()));

    // Measuring the output on the thief's account instead of the user's is refused too.
    instructions[1].accounts[9].pubkey = thief_account;
    let failure = sweep.send(&instructions).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidTokenAccount.into()));

    // So is pulling into an account the swap authority does not own.
    let token = anchor_spl::token::ID;
    send(&mut sweep.env.svm, &thief, create_ata_ix(thief.pubkey(), thief.pubkey(), USDC, token), &[]).unwrap();
    let mut instructions = sweep.sweep_ixs(USDC_TOKEN, PYTH_SPYX_QQQX, &[]);
    instructions[1].accounts[8].pubkey = ata(&thief.pubkey(), &USDC, &token);
    let failure = sweep.send(&instructions).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidTokenAccount.into()));
}

#[test]
fn the_asset_update_must_verify_and_be_usable() {
    let mut sweep = sweep_env(&params());

    let mut tampered = PYTH_SPYX_QQQX.to_vec();
    *tampered.last_mut().unwrap() ^= 1;
    let failure = sweep.send(&sweep.sweep_ixs(USDC_TOKEN, &tampered, &[])).1.unwrap_err();
    assert!(matches!(failure.err, TransactionError::InstructionError(0, _)), "{:?}", failure.err);

    let untrusted = signed_by(PYTH_SPYX_QQQX, &Keypair::new());
    let failure = sweep.send(&sweep.sweep_ixs(USDC_TOKEN, &untrusted, &[])).1.unwrap_err();
    assert!(failure.meta.logs.iter().any(|line| line.contains("NotTrustedSigner")));

    let mut instructions = sweep.sweep_ixs(USDC_TOKEN, PYTH_SPYX_QQQX, &[]);
    instructions[1].accounts[18].pubkey = PYTH_MAINNET.treasury;
    assert!(sweep.send(&instructions).1.is_err());

    // The ed25519 instruction must point at the sweep's asset update, at offset 12.
    let mut instructions = sweep.sweep_ixs(USDC_TOKEN, PYTH_SPYX_QQQX, &[]);
    instructions[0] = ed25519_ix(&[(PYTH_SPYX_QQQX, 1, 13)]);
    assert!(sweep.send(&instructions).1.is_err());

    set_now(&mut sweep.env.svm, PYTH_UPDATES_AT + 61);
    assert_eq!(error_of(sweep_real(&mut sweep, USDC_TOKEN)), Some(LateriteError::StalePrice.into()));
    set_now(&mut sweep.env.svm, PYTH_UPDATES_AT);

    let wide = Quote { confidence: PYTH_SPYX_QUOTE.price / 100, ..PYTH_SPYX_QUOTE };
    let update = pyth_update(PYTH_UPDATES_AT, &[(1843, wide)]);
    let failure = sweep.send(&sweep.sweep_ixs(USDC_TOKEN, &update, &[])).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::PriceUncertain.into()));
    assert_eq!(fetch_user_config(&sweep.env, &sweep.user.pubkey()).last_sweep_day, [0; 2]);
}

#[test]
fn the_display_multiplier_does_not_change_the_minimum() {
    let mut sweep = sweep_env(&params());
    let first = swept(&sweep_real(&mut sweep, USDC_TOKEN).1.unwrap());

    let mut sweep = sweep_env(&params());
    let mut mint = sweep.env.svm.get_account(&SPYX).unwrap();
    let (current, next) = scaled_ui_multipliers(&mint.data);
    mint.data[current..current + 8].copy_from_slice(&2.5f64.to_le_bytes());
    mint.data[next..next + 8].copy_from_slice(&2.5f64.to_le_bytes());
    sweep.env.svm.set_account(SPYX, mint).unwrap();
    let second = swept(&sweep_real(&mut sweep, USDC_TOKEN).1.unwrap());
    assert_eq!((first.min_out, first.received), (second.min_out, second.received));
}

/// Offsets of the current and next multiplier in a Token-2022 mint's ScaledUiAmount extension (type 25).
fn scaled_ui_multipliers(mint: &[u8]) -> (usize, usize) {
    let mut offset = 166;
    loop {
        let kind = u16::from_le_bytes([mint[offset], mint[offset + 1]]);
        let len = usize::from(u16::from_le_bytes([mint[offset + 2], mint[offset + 3]]));
        if kind == 25 {
            return (offset + 4 + 32, offset + 4 + 48);
        }
        offset += 4 + len;
    }
}

#[test]
fn a_killed_program_a_disabled_token_or_a_revoked_delegate_stops_the_sweep() {
    let mut sweep = sweep_env(&EnrollParams { payment_tokens: 0b01, ..params() });
    assert_eq!(error_of(sweep_real(&mut sweep, USDT_TOKEN)), Some(LateriteError::UnknownPaymentToken.into()));

    let admin = sweep.env.authority.insecure_clone();
    send(&mut sweep.env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();
    assert_eq!(error_of(sweep_real(&mut sweep, USDC_TOKEN)), Some(LateriteError::ProgramPaused.into()));
    send(&mut sweep.env.svm, &admin, set_paused_ix(admin.pubkey(), false), &[]).unwrap();

    // SPL Token `Revoke` on the user's USDC account removes the subscription authority's delegation.
    let user = sweep.user.insecure_clone();
    let revoke = Instruction {
        program_id: anchor_spl::token::ID,
        accounts: vec![
            AccountMeta::new(sweep.user_payment_account(USDC_TOKEN), false),
            AccountMeta::new_readonly(user.pubkey(), true),
        ],
        data: vec![5],
    };
    let crank = sweep.crank.insecure_clone();
    send(&mut sweep.env.svm, &crank, revoke, &[&user]).unwrap();
    let failure = sweep_real(&mut sweep, USDC_TOKEN).1.unwrap_err();
    assert!(
        matches!(failure.err, TransactionError::InstructionError(1, InstructionError::Custom(_))),
        "{:?}",
        failure.err
    );
    assert_eq!(fetch_user_config(&sweep.env, &sweep.user.pubkey()).last_sweep_day, [0; 2]);
}

/// A second user's pull through the plan of the first, caller signing as `caller`, into the swap authority's USDC
/// account, then out of it to `thief`: the plan owner's power, if a route ever carried its signature.
fn second_pull_ixs(sweep: &mut SweepEnv, caller: Pubkey, thief: Pubkey) -> [Instruction; 2] {
    let second = enrolled(&mut sweep.env, Keypair::new_from_array([12; 32]), &params()).pubkey();
    let pull = TransferSubscriptionBuilder::new()
        .subscription_pda(subscription_address(USDC_TOKEN, 0, &second))
        .plan_pda(plan_address(USDC_TOKEN, 0))
        .subscription_authority(SubscriptionAuthority::find_pda(&second, &USDC).0)
        .delegator_ata(ata(&second, &USDC, &token::ID))
        .receiver_ata(sweep.swap_payment_account(USDC_TOKEN))
        .caller(caller)
        .token_mint(USDC)
        .token_program(token::ID)
        .event_authority(EventAuthority::find_pda().0)
        .transfer_data(TransferData { amount: 5 * DOLLAR, delegator: second, mint: USDC })
        .instruction();
    let out = token_instruction::transfer_checked(
        &token::ID,
        &sweep.swap_payment_account(USDC_TOKEN),
        &USDC,
        &ata(&thief, &USDC, &token::ID),
        &SWAP_AUTHORITY,
        &[],
        5 * DOLLAR,
        6,
    )
    .unwrap();
    [pull, out]
}

#[test]
fn the_route_signs_only_as_the_swap_authority_and_leaves_its_accounts_as_they_were() {
    let thief = Keypair::new_from_array([13; 32]).pubkey();
    let swap_spyx = ata(&SWAP_AUTHORITY, &SPYX, &token_2022::ID);
    let swap_usdc = ata(&SWAP_AUTHORITY, &USDC, &token::ID);
    let swap_usdt = ata(&SWAP_AUTHORITY, &USDT, &token::ID);
    let fresh = Pubkey::new_from_array([14; 32]);
    // A unit anyone may have sent to the swap authority's SPYx account, or left in its USDC account, the hop of USDT
    // routes.
    let stray_spyx = |_: &mut SweepEnv| {
        let to = ata(&thief, &SPYX, &token_2022::ID);
        vec![token_2022_instruction::transfer_checked(
            &token_2022::ID,
            &swap_spyx,
            &SPYX,
            &to,
            &SWAP_AUTHORITY,
            &[],
            1,
            8,
        )
        .unwrap()]
    };
    let stray_usdc = |_: &mut SweepEnv| {
        let to = ata(&thief, &USDC, &token::ID);
        vec![token_instruction::transfer_checked(&token::ID, &swap_usdc, &USDC, &to, &SWAP_AUTHORITY, &[], 1, 6)
            .unwrap()]
    };
    // No balance moves, but the thief could spend the account's later contents.
    let approve = |_: &mut SweepEnv| {
        vec![token_instruction::approve(&token::ID, &swap_usdt, &thief, &SWAP_AUTHORITY, &[], u64::MAX).unwrap()]
    };
    // The base state stays the same, but every later transfer into the account needs a memo.
    let require_memos = |_: &mut SweepEnv| {
        vec![
            token_2022_instruction::reallocate(
                &token_2022::ID,
                &swap_spyx,
                &SWAP_AUTHORITY,
                &SWAP_AUTHORITY,
                &[],
                &[ExtensionType::MemoTransfer],
            )
            .unwrap(),
            enable_required_transfer_memos(&token_2022::ID, &swap_spyx, &SWAP_AUTHORITY, &[]).unwrap(),
        ]
    };
    // An account the route itself puts under the swap authority.
    let adopt = |_: &mut SweepEnv| {
        vec![token_instruction::initialize_account3(&token::ID, &fresh, &USDC, &SWAP_AUTHORITY).unwrap()]
    };
    // Another subscriber's pull, with the only signature the route carries or with the plan owner's, which it lacks.
    let pull_as_swap = |sweep: &mut SweepEnv| second_pull_ixs(sweep, SWAP_AUTHORITY, thief).to_vec();
    let pull_as_vault = |sweep: &mut SweepEnv| second_pull_ixs(sweep, vault_address(), thief).to_vec();
    type Extra<'a> = &'a dyn Fn(&mut SweepEnv) -> Vec<Instruction>;
    let cases: [(usize, Extra, u32); 7] = [
        (USDC_TOKEN, &stray_spyx, LateriteError::SwapAccountChanged.into()),
        (USDT_TOKEN, &stray_usdc, LateriteError::SwapAccountChanged.into()),
        (USDC_TOKEN, &approve, LateriteError::SwapAccountChanged.into()),
        (USDC_TOKEN, &require_memos, LateriteError::SwapAccountChanged.into()),
        (USDC_TOKEN, &adopt, LateriteError::SwapAccountChanged.into()),
        (USDC_TOKEN, &pull_as_swap, SubscriptionsError::Unauthorized as u32),
        (USDC_TOKEN, &pull_as_vault, SubscriptionsError::NotSigner as u32),
    ];
    for (payment_token, extra, error) in cases {
        let mut sweep = sweep_env_with(&PYTH_DEVNET, TEST_ROUTER, &params());
        let admin = sweep.env.authority.insecure_clone();
        let owned = [(SWAP_AUTHORITY, SPYX, token_2022::ID), (thief, SPYX, token_2022::ID), (thief, USDC, token::ID)];
        for (owner, mint, program) in owned {
            send(&mut sweep.env.svm, &admin, create_ata_ix(admin.pubkey(), owner, mint, program), &[]).unwrap();
        }
        write_amount(&mut sweep.env.svm, swap_spyx, 1);
        write_amount(&mut sweep.env.svm, swap_usdc, 1);
        // Anyone can fund the swap authority, or create an account for the token program to initialize.
        sweep.env.svm.airdrop(&SWAP_AUTHORITY, 1_000_000_000).unwrap();
        let rent = sweep.env.svm.minimum_balance_for_rent_exemption(165);
        sweep.env.svm.airdrop(&fresh, rent).unwrap();
        let mut account = sweep.env.svm.get_account(&fresh).unwrap();
        (account.data, account.owner) = (vec![0; 165], token::ID);
        sweep.env.svm.set_account(fresh, account).unwrap();

        let (asset, payment) = real_updates(payment_token);
        let swap = sweep.cpmm_swap_ix(payment_token, sweep.due(payment_token));
        let mut route = vec![swap.clone()];
        route.extend(extra(&mut sweep));
        let (data, accounts) = test_route(&route);
        let instructions =
            [sweep_ed25519_ix(asset, payment), sweep.sweep_ix(payment_token, asset, payment, data, accounts)];
        let failure = sweep.send(&instructions).1.unwrap_err();
        assert_eq!(custom_code(&failure), Some(error));

        // The same swap alone, through the same router, is a valid sweep, with the swap authority's SPYx account
        // passed writable and left alone, as Jupiter passes the taker's accounts.
        let (data, mut accounts) = test_route(&[swap]);
        accounts.push(AccountMeta::new(swap_spyx, false));
        let instructions =
            [sweep_ed25519_ix(asset, payment), sweep.sweep_ix(payment_token, asset, payment, data, accounts)];
        let event = swept(&sweep.send(&instructions).1.unwrap());
        assert!(event.received >= event.min_out);
    }
}

/// Writes `cu_report.md` at the repository root when `CU_REPORT` is set, for the CU Benchmark workflow.
#[test]
fn cu_report() {
    if std::env::var_os("CU_REPORT").is_none() {
        return;
    }
    let mut report = String::from("| Instruction | Avg CUs | Transaction bytes |\n| --- | --- | --- |\n");
    for (name, payment_token) in [("sweep (USDC, CPMM)", USDC_TOKEN), ("sweep (USDT, CPMM)", USDT_TOKEN)] {
        let mut sweep = sweep_env(&params());
        let (size, result) = sweep_real(&mut sweep, payment_token);
        report.push_str(&format!("| {name} | {} | {size} |\n", result.unwrap().compute_units_consumed));
    }
    // The users' controls, each as the one sponsored transaction the app sends, for a user enrolled with the given
    // tokens who has exited first or not.
    type Build = fn(&LiteSVM, Pubkey) -> Vec<Instruction>;
    let controls: [(&str, u8, bool, Build); 5] = [
        ("change_tier (both tokens, with subscribe and close)", 0b11, false, |svm, user| change_tier_ixs(svm, user, 1)),
        ("change_payment_tokens (drop USDT, with close and revoke)", 0b11, false, |svm, user| {
            change_payment_tokens_ixs(svm, user, 0b01)
        }),
        ("change_payment_tokens (add USDT, with authority and subscribe)", 0b01, false, |svm, user| {
            change_payment_tokens_ixs(svm, user, 0b11)
        }),
        ("exit (both tokens, with close and revoke)", 0b11, false, exit_ixs),
        ("reactivate (both tokens, with authorities and subscribe)", 0b11, true, |svm, user| {
            reactivation_ixs(svm, user, &params())
        }),
    ];
    for (name, payment_tokens, exited, build) in controls {
        let mut sweep = sweep_env(&EnrollParams { payment_tokens, ..params() });
        let user = sweep.user.insecure_clone();
        if exited {
            let exit = exit_ixs(&sweep.env.svm, user.pubkey());
            send_many(&mut sweep.env, &sponsor(), &exit, &[&user]).1.unwrap();
        }
        let instructions = build(&sweep.env.svm, user.pubkey());
        let (size, result) = send_many(&mut sweep.env, &sponsor(), &instructions, &[&user]);
        report.push_str(&format!("| {name} | {} | {size} |\n", result.unwrap().compute_units_consumed));
    }
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../../cu_report.md"), report).unwrap();
}
