mod common;

use {
    anchor_lang::{
        error::ErrorCode,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            pubkey::Pubkey,
        },
    },
    common::*,
    laterite::{
        Attestation, Engine, EnrollParams, EventKind, LateriteError, Settings, UserConfig, UserStatus, DAY_SECONDS,
        WEEK_SECONDS,
    },
    solana_keypair::Keypair,
    solana_signer::Signer,
    solana_system_interface::error::SystemError,
    subscriptions::SubscriptionAuthority,
};

const DOLLAR: u64 = 1_000_000;
const USDC_TOKEN: usize = 0;
const USDT_TOKEN: usize = 1;

/// Sends `instruction` signed by `user`, the sponsor paying the fee; returns the failure's custom code.
fn as_user(env: &mut Env, user: &Keypair, instruction: Instruction) -> Option<u32> {
    let sponsor = sponsor();
    send(&mut env.svm, &sponsor, instruction, &[user]).err().map(|failure| custom_code(&failure).unwrap_or(u32::MAX))
}

fn with_pending(env: &mut Env, user: &Pubkey, pending: u64) {
    let user_config = laterite::UserConfig { pending, ..fetch_user_config(env, user) };
    write_user_config(env, &user_config);
}

/// A transfer of `amount` USDC to or from `user` at `event_time`, told apart by `tag`.
fn transfer(kind: EventKind, user: Pubkey, amount: u64, event_time: i64, tag: u8) -> Attestation {
    Attestation { kind, user, payment_token: 0, amount, event_time, signature: [tag; 64], transfer_index: 0 }
}

fn code(error: LateriteError) -> Option<u32> {
    Some(error.into())
}

/// The settings the user chose, as `enroll` and `reactivate` take them.
fn settings(user_config: &UserConfig) -> EnrollParams {
    EnrollParams {
        tier: user_config.tier,
        payment_tokens: user_config.payment_tokens,
        asset: user_config.asset,
        engine: user_config.engine,
        engine_amount: user_config.engine_amount,
        income_rule: user_config.income_rule,
        change_multiplier: user_config.change_multiplier,
        cushions: user_config.cushions,
        goal_amount: user_config.goal_amount,
        goal_label: user_config.goal_label,
    }
}

/// What outlives an exit: the trial's start, the week's spending, the engine's and the sweeps' days.
fn counters(user_config: &UserConfig) -> (i64, u32, u64, i64, [u32; 2]) {
    let UserConfig { enrolled_at, week, week_spent, engine_ran_at, last_sweep_day, .. } = *user_config;
    (enrolled_at, week, week_spent, engine_ran_at, last_sweep_day)
}

/// The rent of the user's subscriptions to `tier` and of their authorities, for each token in `payment_tokens`.
fn subscription_rents(env: &Env, user: &Pubkey, tier: usize, payment_tokens: u8) -> u64 {
    enabled(payment_tokens)
        .map(|token| {
            let authority = SubscriptionAuthority::find_pda(user, &valid_params().payment_tokens[token].mint).0;
            env.svm.get_balance(&subscription_address(token, tier, user)).unwrap()
                + env.svm.get_balance(&authority).unwrap()
        })
        .sum()
}

#[test]
fn settings_change_everything_but_the_plan() {
    let mut env = with_plans();
    let user = enrolled(&mut env, Keypair::new(), &default_enroll_params());
    let key = user.pubkey();
    let admin = env.authority.insecure_clone();
    send(&mut env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();
    let lowered = Settings { user_weekly_cap: 5 * DOLLAR, ..valid_params().settings };
    send(&mut env.svm, &admin, update_config_ix(admin.pubkey(), lowered), &[]).unwrap();

    // Neither the kill switch nor a beta cap below the user's tier stops them.
    let params =
        EnrollParams { asset: 1, engine: Engine::Weekly, engine_amount: 2 * DOLLAR, ..default_enroll_params() };
    assert_eq!(as_user(&mut env, &user, update_settings_ix(key, params.clone())), None);
    let user_config = fetch_user_config(&env, &key);
    assert_eq!((user_config.asset, user_config.engine, user_config.engine_amount), (1, Engine::Weekly, 2 * DOLLAR));
    assert_eq!((user_config.enrolled_at, user_config.attestable_from), (NOW, NOW));

    for plan_change in
        [EnrollParams { tier: 1, ..params.clone() }, EnrollParams { payment_tokens: 0b01, ..params.clone() }]
    {
        let failure = as_user(&mut env, &user, update_settings_ix(key, plan_change));
        assert_eq!(failure, code(LateriteError::PlanChangeRequired));
    }
    let invalid = EnrollParams { change_multiplier: 4, ..params };
    assert_eq!(as_user(&mut env, &user, update_settings_ix(key, invalid)), code(LateriteError::InvalidRules));
    assert_eq!(as_user(&mut env, &user, set_user_paused_ix(key, true)), None);
    assert_eq!(as_user(&mut env, &user, set_user_paused_ix(key, false)), None);
    assert_eq!(as_user(&mut env, &user, lower_pending_ix(key, 0)), None);
}

#[test]
fn settings_that_count_more_credit_only_later_transfers() {
    let mut env = with_plans();
    let user = enrolled(&mut env, Keypair::new(), &default_enroll_params());
    let key = user.pubkey();
    let crank = funded(&mut env.svm);

    let income_on = EnrollParams { income_rule: true, ..default_enroll_params() };
    set_now(&mut env.svm, NOW + 100);
    assert_eq!(as_user(&mut env, &user, update_settings_ix(key, income_on.clone())), None);
    assert_eq!(fetch_user_config(&env, &key).attestable_from, NOW + 100);
    let before = transfer(EventKind::Income, key, 1_000 * DOLLAR, NOW + 50, 1);
    let failure = submit_attestation(&mut env, &crank, &before, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::InvalidAttestation));
    let after = transfer(EventKind::Income, key, 1_000 * DOLLAR, NOW + 100, 2);
    submit_attestation(&mut env, &crank, &after, &attestor()).unwrap();

    // Change per payment turned on raises it again, and so does a larger multiplier; a smaller one does not.
    set_now(&mut env.svm, NOW + 200);
    let change_on = EnrollParams { change_multiplier: 1, ..income_on };
    assert_eq!(as_user(&mut env, &user, update_settings_ix(key, change_on.clone())), None);
    assert_eq!(fetch_user_config(&env, &key).attestable_from, NOW + 200);
    set_now(&mut env.svm, NOW + 300);
    let larger = EnrollParams { change_multiplier: 3, ..change_on.clone() };
    assert_eq!(as_user(&mut env, &user, update_settings_ix(key, larger)), None);
    assert_eq!(fetch_user_config(&env, &key).attestable_from, NOW + 300);
    let before = transfer(EventKind::Payment, key, 3_200_000, NOW + 250, 3);
    let failure = submit_attestation(&mut env, &crank, &before, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::InvalidAttestation));
    let payment = transfer(EventKind::Payment, key, 3_200_000, NOW + 300, 4);
    submit_attestation(&mut env, &crank, &payment, &attestor()).unwrap();
    set_now(&mut env.svm, NOW + 400);
    let smaller = EnrollParams { change_multiplier: 2, ..change_on };
    assert_eq!(as_user(&mut env, &user, update_settings_ix(key, smaller)), None);
    assert_eq!(fetch_user_config(&env, &key).attestable_from, NOW + 300);
    assert_eq!(fetch_user_config(&env, &key).pending, 100 * DOLLAR + 3 * 800_000);
}

#[test]
fn a_paused_user_is_neither_swept_nor_credited() {
    let mut sweep = sweep_env(&EnrollParams { income_rule: true, ..default_enroll_params() });
    let user = sweep.user.insecure_clone();
    let key = user.pubkey();
    assert_eq!(as_user(&mut sweep.env, &user, set_user_paused_ix(key, false)), code(LateriteError::UserNotPaused));
    assert_eq!(as_user(&mut sweep.env, &user, set_user_paused_ix(key, true)), None);
    assert_eq!(as_user(&mut sweep.env, &user, set_user_paused_ix(key, true)), code(LateriteError::UserNotActive));
    assert_eq!(fetch_user_config(&sweep.env, &key).status, UserStatus::Paused);

    let failure = sweep.send(&sweep.sweep_ixs(USDC_TOKEN, PYTH_SPYX_QQQX, &[])).1.unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::NothingToSweep));
    let crank = sweep.crank.insecure_clone();
    let during = transfer(EventKind::Income, key, 1_000 * DOLLAR, PYTH_UPDATES_AT, 1);
    let failure = submit_attestation(&mut sweep.env, &crank, &during, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::UserNotActive));
    let user_config = fetch_user_config(&sweep.env, &key);
    assert_eq!((user_config.pending, user_config.last_sweep_day), (0, [0; 2]));

    let resumed = PYTH_UPDATES_AT + 10;
    set_now(&mut sweep.env.svm, resumed);
    assert_eq!(as_user(&mut sweep.env, &user, set_user_paused_ix(key, false)), None);
    let user_config = fetch_user_config(&sweep.env, &key);
    assert_eq!((user_config.status, user_config.attestable_from), (UserStatus::Active, resumed));
    sweep.send(&sweep.sweep_ixs(USDC_TOKEN, PYTH_SPYX_QQQX, &[])).1.unwrap();

    // A transfer made during the pause never counts, even attested after the resume; a later one does.
    set_now(&mut sweep.env.svm, resumed + 60);
    let failure = submit_attestation(&mut sweep.env, &crank, &during, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::InvalidAttestation));
    let after = transfer(EventKind::Income, key, 1_000 * DOLLAR, resumed + 30, 2);
    submit_attestation(&mut sweep.env, &crank, &after, &attestor()).unwrap();
    assert_eq!(fetch_user_config(&sweep.env, &key).pending, 100 * DOLLAR);
}

#[test]
fn pending_can_only_be_lowered() {
    let mut env = with_plans();
    let user = enrolled(&mut env, Keypair::new(), &default_enroll_params());
    let key = user.pubkey();
    with_pending(&mut env, &key, 50 * DOLLAR);
    assert_eq!(as_user(&mut env, &user, lower_pending_ix(key, 51 * DOLLAR)), code(LateriteError::PendingIncrease));
    assert_eq!(as_user(&mut env, &user, lower_pending_ix(key, 2 * DOLLAR)), None);
    assert_eq!(fetch_user_config(&env, &key).pending, 2 * DOLLAR);
    assert_eq!(as_user(&mut env, &user, lower_pending_ix(key, 0)), None);
    assert_eq!(fetch_user_config(&env, &key).pending, 0);
}

#[test]
fn a_tier_change_moves_the_subscriptions_and_keeps_the_week() {
    let mut sweep = sweep_env(&EnrollParams { tier: 1, ..default_enroll_params() });
    let user = sweep.user.insecure_clone();
    let key = user.pubkey();
    // Past the trial the $25 tier binds: $21 is swept in week 1.
    set_now(&mut sweep.env.svm, NOW + WEEK_SECONDS + 3_600);
    with_pending(&mut sweep.env, &key, 20 * DOLLAR);
    sweep.sweep_now(USDC_TOKEN).1.unwrap();

    // Neither the kill switch nor a paused user stops a tier change.
    let admin = sweep.env.authority.insecure_clone();
    send(&mut sweep.env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();
    assert_eq!(as_user(&mut sweep.env, &user, set_user_paused_ix(key, true)), None);
    let instructions = change_tier_ixs(&sweep.env.svm, key, 0);
    let (size, result) = send_many(&mut sweep.env, &sponsor(), &instructions, &[&user]);
    let metadata = result.unwrap();
    println!(
        "change_tier transaction: {size} B, {} CU, {} in change_tier",
        metadata.compute_units_consumed,
        units_of(&metadata, &laterite::ID)[0]
    );
    assert_eq!(as_user(&mut sweep.env, &user, set_user_paused_ix(key, false)), None);
    send(&mut sweep.env.svm, &admin, set_paused_ix(admin.pubkey(), false), &[]).unwrap();

    let user_config = fetch_user_config(&sweep.env, &key);
    assert_eq!((user_config.tier, user_config.week_spent), (0, 21 * DOLLAR));
    for token in [USDC_TOKEN, USDT_TOKEN] {
        assert!(sweep.env.svm.get_account(&subscription_address(token, 1, &key)).is_none());
        assert!(sweep.env.svm.get_account(&subscription_address(token, 0, &key)).is_some());
    }
    // $21 already spent against the new $10 cap: nothing more this week.
    assert_eq!(custom_code(&sweep.sweep_now(USDT_TOKEN).1.unwrap_err()), code(LateriteError::NothingToSweep));
}

#[test]
fn a_tier_change_needs_the_new_subscriptions_and_fits_the_limits() {
    let mut env = with_plans();
    let user = enrolled(&mut env, Keypair::new(), &default_enroll_params());
    let key = user.pubkey();

    assert_eq!(as_user(&mut env, &user, change_tier_ix(key, 0, 1, 0b11)), code(LateriteError::SubscriptionMismatch));
    assert_eq!(as_user(&mut env, &user, change_tier_ix(key, 0, 0, 0b11)), code(LateriteError::InvalidTier));
    // The ended subscription is named by its derived address: another account is refused.
    let mut wrong = change_tier_ix(key, 0, 1, 0b11);
    wrong.accounts[7].pubkey = subscription_address(USDT_TOKEN, 0, &key);
    assert_eq!(as_user(&mut env, &user, wrong), code(LateriteError::SubscriptionMismatch));

    let admin = env.authority.insecure_clone();
    let lowered = Settings { user_weekly_cap: 10 * DOLLAR, ..valid_params().settings };
    send(&mut env.svm, &admin, update_config_ix(admin.pubkey(), lowered), &[]).unwrap();
    let instructions = change_tier_ixs(&env.svm, key, 1);
    let failure = send_many(&mut env, &sponsor(), &instructions, &[&user]).1.unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::CapAboveBetaLimit));
    assert_eq!(fetch_user_config(&env, &key).tier, 0);

    // The engine must fit the new tier: a $15 engine cannot move down to $10.
    let mut env = with_plans();
    let params = EnrollParams { tier: 1, engine_amount: 15 * DOLLAR, ..default_enroll_params() };
    let user = enrolled(&mut env, Keypair::new(), &params);
    let instructions = change_tier_ixs(&env.svm, user.pubkey(), 0);
    let failure = send_many(&mut env, &sponsor(), &instructions, &[&user]).1.unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::InvalidRules));
}

#[test]
fn the_sweep_stays_within_a_shifted_native_period() {
    let mut sweep = sweep_env(&default_enroll_params());
    let user = sweep.user.insecure_clone();
    let key = user.pubkey();
    // Moving to $25 halfway through week 1 starts the new subscriptions' periods there, not on a week boundary.
    set_now(&mut sweep.env.svm, NOW + WEEK_SECONDS + WEEK_SECONDS / 2);
    let instructions = change_tier_ixs(&sweep.env.svm, key, 1);
    send_many(&mut sweep.env, &sponsor(), &instructions, &[&user]).1.unwrap();
    with_pending(&mut sweep.env, &key, 20 * DOLLAR);
    let event = swept(&sweep.sweep_now(USDC_TOKEN).1.unwrap());
    assert_eq!(event.engine + event.pending, 21 * DOLLAR);

    // Week 2 allows $25 again, but the native period still counts $21 until it rolls: the pull shrinks to $4 instead
    // of failing inside Subscriptions.
    set_now(&mut sweep.env.svm, NOW + 2 * WEEK_SECONDS + 3_600);
    with_pending(&mut sweep.env, &key, 20 * DOLLAR);
    assert_eq!(sweep.due(USDC_TOKEN), 4 * DOLLAR);
    let event = swept(&sweep.sweep_now(USDC_TOKEN).1.unwrap());
    assert_eq!((event.engine, event.pending), (DOLLAR, 3 * DOLLAR));
}

#[test]
fn payment_tokens_change_in_place() {
    let mut sweep = sweep_env(&EnrollParams { change_multiplier: 1, ..default_enroll_params() });
    let user = sweep.user.insecure_clone();
    let key = user.pubkey();
    sweep.send(&sweep.sweep_ixs(USDT_TOKEN, PYTH_SPYX_QQQX, PYTH_USDT)).1.unwrap();
    let swept_day = fetch_user_config(&sweep.env, &key).last_sweep_day;
    for (tokens, error) in [(0, LateriteError::NoPaymentToken), (0b111, LateriteError::UnknownPaymentToken)] {
        assert_eq!(as_user(&mut sweep.env, &user, change_payment_tokens_ix(key, 0, 0b11, tokens)), code(error));
    }
    // The dropped subscription is named by its derived address: another user's, an empty account or another plan is
    // refused, and the user's own stays live.
    let other = enrolled(&mut sweep.env, Keypair::new_from_array([12; 32]), &default_enroll_params()).pubkey();
    for (index, wrong) in
        [(6, subscription_address(USDT_TOKEN, 0, &other)), (6, Pubkey::new_unique()), (5, plan_address(USDT_TOKEN, 1))]
    {
        let mut instruction = change_payment_tokens_ix(key, 0, 0b11, 0b01);
        instruction.accounts[index].pubkey = wrong;
        assert_eq!(as_user(&mut sweep.env, &user, instruction), code(LateriteError::SubscriptionMismatch));
    }
    assert!(native_remaining(&sweep.env.svm, &subscription_address(USDT_TOKEN, 0, &key), PYTH_UPDATES_AT) > 0);
    let sponsor_before = sweep.env.svm.get_balance(&sponsor().pubkey()).unwrap();
    let usdt_authority = SubscriptionAuthority::find_pda(&key, &USDT).0;
    let rents = sweep.env.svm.get_balance(&subscription_address(USDT_TOKEN, 0, &key)).unwrap()
        + sweep.env.svm.get_balance(&usdt_authority).unwrap();

    // Dropping USDT under the kill switch ends and closes its subscription and revokes its authority, rents to the
    // sponsor.
    let admin = sweep.env.authority.insecure_clone();
    send(&mut sweep.env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();
    let instructions = change_payment_tokens_ixs(&sweep.env.svm, key, 0b01);
    let (size, result) = send_many(&mut sweep.env, &sponsor(), &instructions, &[&user]);
    let metadata = result.unwrap();
    println!(
        "change_payment_tokens transaction, USDT dropped: {size} B, {} CU, {} in change_payment_tokens",
        metadata.compute_units_consumed,
        units_of(&metadata, &laterite::ID)[0]
    );
    send(&mut sweep.env.svm, &admin, set_paused_ix(admin.pubkey(), false), &[]).unwrap();
    assert_eq!(sweep.env.svm.get_balance(&sponsor().pubkey()).unwrap(), sponsor_before + rents - 10_000);
    assert!(sweep.env.svm.get_account(&subscription_address(USDT_TOKEN, 0, &key)).is_none());
    assert!(sweep.env.svm.get_account(&usdt_authority).is_none());
    let user_config = fetch_user_config(&sweep.env, &key);
    assert_eq!((user_config.payment_tokens, user_config.attestable_from), (0b01, NOW));
    let crank = sweep.crank.insecure_clone();
    let before = Attestation { payment_token: 1, ..transfer(EventKind::Payment, key, 3_200_000, PYTH_UPDATES_AT, 1) };
    let failure = submit_attestation(&mut sweep.env, &crank, &before, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::UnknownPaymentToken));

    // Adding it back needs a live subscription, credits only later transfers and keeps the day's sweep spent.
    let added = PYTH_UPDATES_AT + 5;
    set_now(&mut sweep.env.svm, added);
    let failure = as_user(&mut sweep.env, &user, change_payment_tokens_ix(key, 0, 0b01, 0b11));
    assert_eq!(failure, code(LateriteError::SubscriptionMismatch));
    let instructions = change_payment_tokens_ixs(&sweep.env.svm, key, 0b11);
    let (size, result) = send_many(&mut sweep.env, &sponsor(), &instructions, &[&user]);
    let metadata = result.unwrap();
    println!(
        "change_payment_tokens transaction, USDT added: {size} B, {} CU, {} in change_payment_tokens",
        metadata.compute_units_consumed,
        units_of(&metadata, &laterite::ID)[0]
    );
    let user_config = fetch_user_config(&sweep.env, &key);
    assert_eq!((user_config.payment_tokens, user_config.attestable_from), (0b11, added));
    assert_eq!(user_config.last_sweep_day, swept_day);
    let failure = sweep.send(&sweep.sweep_ixs(USDT_TOKEN, PYTH_SPYX_QQQX, PYTH_USDT)).1.unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::AlreadySwept));
    set_now(&mut sweep.env.svm, added + 60);
    let failure = submit_attestation(&mut sweep.env, &crank, &before, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::InvalidAttestation));
    let after = Attestation { event_time: added + 30, signature: [2; 64], ..before };
    submit_attestation(&mut sweep.env, &crank, &after, &attestor()).unwrap();
}

#[test]
fn exit_keeps_the_account_and_its_counters() {
    let mut sweep = sweep_env(&EnrollParams { change_multiplier: 1, ..default_enroll_params() });
    let user = sweep.user.insecure_clone();
    let key = user.pubkey();
    with_pending(&mut sweep.env, &key, 2 * DOLLAR);
    sweep.send(&sweep.sweep_ixs(USDC_TOKEN, PYTH_SPYX_QQQX, &[])).1.unwrap();
    with_pending(&mut sweep.env, &key, 7 * DOLLAR);
    let before = fetch_user_config(&sweep.env, &key);

    // Neither the kill switch nor a paused user stops an exit.
    assert_eq!(as_user(&mut sweep.env, &user, set_user_paused_ix(key, true)), None);
    let admin = sweep.env.authority.insecure_clone();
    send(&mut sweep.env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();
    let rents = subscription_rents(&sweep.env, &key, 0, 0b11);
    let (users, sponsor_before) =
        (fetch_config(&sweep.env.svm).user_count, sweep.env.svm.get_balance(&sponsor().pubkey()));
    let user_config_rent = sweep.env.svm.get_balance(&user_config_address(&key)).unwrap();
    let stale_sweep = sweep.sweep_ixs(USDT_TOKEN, PYTH_SPYX_QQQX, PYTH_USDT);
    let instructions = exit_ixs(&sweep.env.svm, key);
    let (size, result) = send_many(&mut sweep.env, &sponsor(), &instructions, &[&user]);
    let metadata = result.unwrap();
    println!(
        "exit transaction: {size} B, {} CU, {} in exit",
        metadata.compute_units_consumed,
        units_of(&metadata, &laterite::ID)[0]
    );
    send(&mut sweep.env.svm, &admin, set_paused_ix(admin.pubkey(), false), &[]).unwrap();

    // The subscriptions and authorities are closed, their rents back to the sponsor; the account stays with its rent.
    assert_eq!(sweep.env.svm.get_balance(&sponsor().pubkey()), sponsor_before.map(|balance| balance + rents - 10_000));
    assert_eq!(sweep.env.svm.get_balance(&user_config_address(&key)).unwrap(), user_config_rent);
    assert_eq!(subscription_rents(&sweep.env, &key, 0, 0), 0);
    for token in [USDC_TOKEN, USDT_TOKEN] {
        assert!(sweep.env.svm.get_account(&subscription_address(token, 0, &key)).is_none());
    }
    let user_config = fetch_user_config(&sweep.env, &key);
    assert_eq!((user_config.status, user_config.pending), (UserStatus::Exited, 0));
    assert_eq!(settings(&user_config), EnrollParams::default());
    assert_eq!(counters(&user_config), counters(&before));
    assert_eq!(user_config.attestable_from, before.attestable_from);
    assert_eq!(fetch_config(&sweep.env.svm).user_count, users - 1);

    // Nothing is swept or credited, and every other control and a second enrollment are refused.
    assert_eq!(custom_code(&sweep.send(&stale_sweep).1.unwrap_err()), code(LateriteError::NothingToSweep));
    let crank = sweep.crank.insecure_clone();
    let payment = transfer(EventKind::Payment, key, 3_200_000, PYTH_UPDATES_AT, 1);
    let failure = submit_attestation(&mut sweep.env, &crank, &payment, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::UserNotActive));
    let controls = [
        update_settings_ix(key, EnrollParams::default()),
        set_user_paused_ix(key, true),
        set_user_paused_ix(key, false),
        lower_pending_ix(key, 0),
        change_tier_ix(key, 0, 1, 0),
        change_payment_tokens_ix(key, 0, 0, 0b01),
        exit_ix(key, 0, 0),
    ];
    for control in controls {
        assert_eq!(as_user(&mut sweep.env, &user, control), code(LateriteError::UserNotActive));
    }
    let onboarding = onboarding_ixs(&sweep.env.svm, key, sponsor().pubkey(), &default_enroll_params());
    let failure = send_many(&mut sweep.env, &sponsor(), &onboarding, &[&user]).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(SystemError::AccountAlreadyInUse as u32));
}

#[test]
fn a_returning_user_reactivates_the_same_account_under_enrollments_checks() {
    let mut sweep = sweep_env(&EnrollParams { income_rule: true, ..default_enroll_params() });
    let user = sweep.user.insecure_clone();
    let key = user.pubkey();
    // The trial week's $5 is spent: $1 for the engine and $4 pending.
    with_pending(&mut sweep.env, &key, 4 * DOLLAR);
    sweep.send(&sweep.sweep_ixs(USDC_TOKEN, PYTH_SPYX_QQQX, &[])).1.unwrap();
    let instructions = exit_ixs(&sweep.env.svm, key);
    send_many(&mut sweep.env, &sponsor(), &instructions, &[&user]).1.unwrap();
    let exited = fetch_user_config(&sweep.env, &key);
    let users = fetch_config(&sweep.env.svm).user_count;

    let reactivated = PYTH_UPDATES_AT + 20;
    set_now(&mut sweep.env.svm, reactivated);
    let params = EnrollParams { tier: 1, engine_amount: 2 * DOLLAR, income_rule: true, ..default_enroll_params() };
    let admin = sweep.env.authority.insecure_clone();
    send(&mut sweep.env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();
    let instructions = reactivation_ixs(&sweep.env.svm, key, &params);
    let failure = send_many(&mut sweep.env, &sponsor(), &instructions, &[&user]).1.unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::ProgramPaused));
    send(&mut sweep.env.svm, &admin, set_paused_ix(admin.pubkey(), false), &[]).unwrap();
    // The seat freed by the exit goes to someone else.
    enrolled(&mut sweep.env, Keypair::new(), &default_enroll_params());
    let full = Settings { max_users: users + 1, ..valid_params().settings };
    send(&mut sweep.env.svm, &admin, update_config_ix(admin.pubkey(), full), &[]).unwrap();
    let failure = send_many(&mut sweep.env, &sponsor(), &instructions, &[&user]).1.unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::BetaFull));
    send(&mut sweep.env.svm, &admin, update_config_ix(admin.pubkey(), valid_params().settings), &[]).unwrap();
    let failure = as_user(&mut sweep.env, &user, reactivate_ix(key, sponsor().pubkey(), params.clone()));
    assert_eq!(failure, code(LateriteError::SubscriptionMismatch));
    let stranger = funded(&mut sweep.env.svm);
    let failure = send(&mut sweep.env.svm, &stranger, reactivate_ix(key, stranger.pubkey(), params.clone()), &[&user]);
    assert_eq!(custom_code(&failure.unwrap_err()), code(LateriteError::NotSponsor));

    let (size, result) = send_many(&mut sweep.env, &sponsor(), &instructions, &[&user]);
    let metadata = result.unwrap();
    println!(
        "reactivation transaction: {size} B, {} CU, {} in reactivate",
        metadata.compute_units_consumed,
        units_of(&metadata, &laterite::ID)[0]
    );
    let user_config = fetch_user_config(&sweep.env, &key);
    assert_eq!((user_config.status, user_config.attestable_from), (UserStatus::Active, reactivated));
    assert_eq!(settings(&user_config), params);
    assert_eq!(counters(&user_config), counters(&exited));
    assert_eq!(fetch_config(&sweep.env.svm).user_count, users + 2);
    let failure = as_user(&mut sweep.env, &user, reactivate_ix(key, sponsor().pubkey(), params));
    assert_eq!(failure, code(LateriteError::UserNotExited));

    // No second sweep that day and no second trial: the trial week's $5 stays spent.
    assert_eq!(custom_code(&sweep.sweep_now(USDC_TOKEN).1.unwrap_err()), code(LateriteError::AlreadySwept));
    assert_eq!(custom_code(&sweep.sweep_now(USDT_TOKEN).1.unwrap_err()), code(LateriteError::NothingToSweep));
    set_now(&mut sweep.env.svm, reactivated + DAY_SECONDS);
    assert_eq!(custom_code(&sweep.sweep_now(USDC_TOKEN).1.unwrap_err()), code(LateriteError::NothingToSweep));

    // Only transfers from the reactivation on are credited.
    let crank = sweep.crank.insecure_clone();
    let before = transfer(EventKind::Income, key, 1_000 * DOLLAR, reactivated - 10, 1);
    let failure = submit_attestation(&mut sweep.env, &crank, &before, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), code(LateriteError::InvalidAttestation));
    let after = transfer(EventKind::Income, key, 1_000 * DOLLAR, reactivated + 5, 2);
    submit_attestation(&mut sweep.env, &crank, &after, &attestor()).unwrap();
    assert_eq!(fetch_user_config(&sweep.env, &key).pending, 100 * DOLLAR);
}

#[test]
fn reactivation_needs_the_sponsors_signature() {
    let mut env = with_plans();
    let user = enrolled(&mut env, Keypair::new(), &default_enroll_params());
    let key = user.pubkey();
    let instructions = exit_ixs(&env.svm, key);
    send_many(&mut env, &sponsor(), &instructions, &[&user]).1.unwrap();

    // The configured sponsor named but not signing, with someone else paying the fee.
    let mut instructions = reactivation_ixs(&env.svm, key, &default_enroll_params());
    let stranger = funded(&mut env.svm);
    for instruction in &mut instructions {
        for meta in instruction.accounts.iter_mut().filter(|meta| meta.pubkey == sponsor().pubkey()) {
            meta.pubkey = stranger.pubkey();
        }
    }
    let reactivate = instructions.last_mut().unwrap();
    reactivate.accounts[1] = AccountMeta::new_readonly(sponsor().pubkey(), false);
    let failure = send_many(&mut env, &stranger, &instructions, &[&user]).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(ErrorCode::AccountNotSigner.into()));
    assert_eq!(fetch_user_config(&env, &key).status, UserStatus::Exited);
}

#[test]
fn exit_ends_only_the_users_own_subscriptions() {
    let mut env = with_plans();
    let user = enrolled(&mut env, Keypair::new(), &default_enroll_params());
    let key = user.pubkey();
    let other = enrolled(&mut env, Keypair::new(), &default_enroll_params()).pubkey();
    // Another user's subscription, an empty account or another plan is refused rather than skipped, and the user's
    // own subscriptions stay live.
    for (index, wrong) in
        [(7, subscription_address(USDC_TOKEN, 0, &other)), (9, Pubkey::new_unique()), (6, plan_address(USDC_TOKEN, 1))]
    {
        let mut instruction = exit_ix(key, 0, 0b11);
        instruction.accounts[index].pubkey = wrong;
        assert_eq!(as_user(&mut env, &user, instruction), code(LateriteError::SubscriptionMismatch));
    }
    let live = |env: &Env, user: &Pubkey| {
        [USDC_TOKEN, USDT_TOKEN].map(|token| native_remaining(&env.svm, &subscription_address(token, 0, user), NOW) > 0)
    };
    assert_eq!((fetch_user_config(&env, &key).status, live(&env, &key)), (UserStatus::Active, [true; 2]));

    assert_eq!(as_user(&mut env, &user, exit_ix(key, 0, 0b11)), None);
    assert_eq!(live(&env, &key), [false; 2]);
    assert_eq!(live(&env, &other), [true; 2]);
}

#[test]
fn exit_works_after_the_user_ended_subscriptions_through_subscriptions() {
    let mut env = with_plans();
    let user = enrolled(&mut env, Keypair::new(), &default_enroll_params());
    let key = user.pubkey();
    // USDC cancelled and, once its period ran out, closed; USDT cancelled but still running, its authority revoked.
    assert_eq!(as_user(&mut env, &user, cancel_subscription_ix(USDC_TOKEN, 0, key)), None);
    set_now(&mut env.svm, NOW + WEEK_SECONDS);
    let close = close_subscription_ix(&env.svm, key, USDC_TOKEN, 0);
    assert_eq!(as_user(&mut env, &user, close), None);
    set_now(&mut env.svm, NOW + WEEK_SECONDS + 10);
    assert_eq!(as_user(&mut env, &user, cancel_subscription_ix(USDT_TOKEN, 0, key)), None);
    let revoke = revoke_authority_ix(&env.svm, key, USDT_TOKEN);
    assert_eq!(as_user(&mut env, &user, revoke), None);

    // The closed one is skipped; the running one ends at once and closes in the same transaction.
    let instructions = [exit_ix(key, 0, 0b11), close_subscription_ix(&env.svm, key, USDT_TOKEN, 0)];
    send_many(&mut env, &sponsor(), &instructions, &[&user]).1.unwrap();
    assert_eq!(fetch_user_config(&env, &key).status, UserStatus::Exited);
    assert!(env.svm.get_account(&subscription_address(USDT_TOKEN, 0, &key)).is_none());
}

#[test]
fn exit_repays_whoever_paid_after_a_sponsor_rotation() {
    let mut env = with_plans();
    let user = enrolled(&mut env, Keypair::new(), &default_enroll_params());
    let key = user.pubkey();
    let admin = env.authority.insecure_clone();
    let rotated = funded(&mut env.svm);
    let settings = Settings { sponsor: rotated.pubkey(), ..valid_params().settings };
    send(&mut env.svm, &admin, update_config_ix(admin.pubkey(), settings), &[]).unwrap();

    let before = env.svm.get_balance(&sponsor().pubkey()).unwrap();
    let rents = subscription_rents(&env, &key, 0, 0b11);
    let instructions = exit_ixs(&env.svm, key);
    send_many(&mut env, &rotated, &instructions, &[&user]).1.unwrap();
    assert_eq!(env.svm.get_balance(&sponsor().pubkey()).unwrap(), before + rents);

    // Reactivation takes the sponsor configured now.
    let params = default_enroll_params();
    let failure = as_user(&mut env, &user, reactivate_ix(key, sponsor().pubkey(), params.clone()));
    assert_eq!(failure, code(LateriteError::NotSponsor));
    let mut instructions: Vec<_> = enabled(params.payment_tokens)
        .flat_map(|token| subscribe_ixs(&env.svm, key, rotated.pubkey(), token, 0))
        .collect();
    instructions.push(reactivate_ix(key, rotated.pubkey(), params));
    send_many(&mut env, &rotated, &instructions, &[&user]).1.unwrap();
    assert_eq!(fetch_user_config(&env, &key).status, UserStatus::Active);
}
