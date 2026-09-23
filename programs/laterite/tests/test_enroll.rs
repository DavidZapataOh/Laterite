mod common;

use {
    anchor_lang::{AccountDeserialize, Space},
    common::*,
    laterite::{LateriteError, UserConfig},
    solana_compute_budget_interface::ComputeBudgetInstruction,
    solana_keypair::Keypair,
    solana_signer::Signer,
    subscriptions::{SubscriptionAuthority, SubscriptionDelegation},
};

fn fetch_user_config(env: &Env, user: &anchor_lang::solana_program::pubkey::Pubkey) -> UserConfig {
    let account = env.svm.get_account(&user_config_address(user)).unwrap();
    UserConfig::try_deserialize(&mut account.data.as_slice()).unwrap()
}

#[test]
fn user_config_is_179_bytes() {
    assert_eq!(8 + UserConfig::INIT_SPACE, 179);
}

#[test]
fn onboarding_is_one_sponsored_transaction() {
    let mut env = with_plans();
    let sponsor = sponsor();
    // A fixed user key, so the bump searches for the user's accounts, and the compute units, repeat on every run.
    let user = fund_user(&mut env.svm, Keypair::new_from_array([9; 32]));
    let params = default_enroll_params();
    let mut instructions = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(200_000),
        ComputeBudgetInstruction::set_compute_unit_price(1),
    ];
    instructions.extend(onboarding_ixs(&env.svm, user.pubkey(), sponsor.pubkey(), &params));

    let (size, result) = send_many(&mut env, &sponsor, &instructions, &[&user]);
    let metadata = result.unwrap();
    let prefix = format!("Program {} consumed ", laterite::ID);
    let enroll =
        metadata.logs.iter().rev().find_map(|log| log.strip_prefix(&prefix)?.split(' ').next()?.parse::<u64>().ok());
    println!(
        "onboarding, both tokens, with a compute budget: {size} bytes, {} compute units, {} in enroll",
        metadata.compute_units_consumed,
        enroll.unwrap()
    );
    assert!(size <= 1232, "{size} bytes");
    // The range docs/003-onboarding-transaction.md measured over random users.
    assert!((60_150..=93_150).contains(&metadata.compute_units_consumed));

    let config = fetch_user_config(&env, &user.pubkey());
    assert_eq!(config.user, user.pubkey());
    assert_eq!(config.payer, sponsor.pubkey());
    assert_eq!(config.payment_tokens, 0b11);
    assert_eq!(config.enrolled_at, NOW);
    assert_eq!((config.week, config.week_spent, config.engine_ran_at, config.pending), (0, 0, 0, 0));
    assert_eq!(&config.goal_label[..5], b"House");
    assert_eq!(fetch_config(&env.svm).user_count, 1);
    assert!(env.svm.get_account(&user.pubkey()).is_none_or(|account| account.lamports == 0));

    // The sponsor is recorded, so closing these accounts later refunds it.
    for token in valid_params().payment_tokens {
        let authority = SubscriptionAuthority::find_pda(&user.pubkey(), &token.mint).0;
        let state = SubscriptionAuthority::from_bytes(&env.svm.get_account(&authority).unwrap().data).unwrap();
        assert_eq!(state.payer, sponsor.pubkey());
    }
    for payment_token in 0..2usize {
        let subscription = subscription_address(payment_token, 0, &user.pubkey());
        let state = SubscriptionDelegation::from_bytes(&env.svm.get_account(&subscription).unwrap().data).unwrap();
        assert_eq!(state.header.payer, sponsor.pubkey());
    }

    let asset = valid_params().assets[params.asset as usize % 2];
    let asset_ata = ata(&user.pubkey(), &asset.mint, &asset.token_program);
    assert_eq!(env.svm.get_account(&asset_ata).unwrap().data[108], 1);
}

#[test]
fn only_the_sponsor_pays_for_enrollment() {
    let mut env = with_plans();
    let stranger = funded(&mut env.svm);
    let user = user_with_balances(&mut env.svm);
    let instruction = enroll_ix(user.pubkey(), stranger.pubkey(), default_enroll_params(), &[]);
    let failure = send(&mut env.svm, &stranger, instruction, &[&user]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::NotSponsor.into()));
}

#[test]
fn a_user_enrolls_once() {
    let mut env = with_plans();
    let sponsor = sponsor();
    let user = user_with_balances(&mut env.svm);
    let params = default_enroll_params();
    let instructions = onboarding_ixs(&env.svm, user.pubkey(), sponsor.pubkey(), &params);
    send_many(&mut env, &sponsor, &instructions, &[&user]).1.unwrap();

    let subscriptions = [subscription_address(0, 0, &user.pubkey()), subscription_address(1, 0, &user.pubkey())];
    let again = enroll_ix(user.pubkey(), sponsor.pubkey(), params, &subscriptions);
    let failure = send(&mut env.svm, &sponsor, again, &[&user]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(0));
}

#[test]
fn the_kill_switch_and_the_beta_caps_hold() {
    let mut env = with_plans();
    let admin = env.authority.insecure_clone();
    let sponsor = sponsor();

    send(&mut env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();
    let user = user_with_balances(&mut env.svm);
    let instructions = onboarding_ixs(&env.svm, user.pubkey(), sponsor.pubkey(), &default_enroll_params());
    let failure = send_many(&mut env, &sponsor, &instructions, &[&user]).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::ProgramPaused.into()));
    send(&mut env.svm, &admin, set_paused_ix(admin.pubkey(), false), &[]).unwrap();

    let mut settings = valid_params().settings;
    settings.user_weekly_cap = 10_000_000;
    settings.max_users = 1;
    send(&mut env.svm, &admin, update_config_ix(admin.pubkey(), settings), &[]).unwrap();

    let mut above_cap = default_enroll_params();
    above_cap.tier = 1;
    let instructions = onboarding_ixs(&env.svm, user.pubkey(), sponsor.pubkey(), &above_cap);
    let failure = send_many(&mut env, &sponsor, &instructions, &[&user]).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::CapAboveBetaLimit.into()));

    let instructions = onboarding_ixs(&env.svm, user.pubkey(), sponsor.pubkey(), &default_enroll_params());
    send_many(&mut env, &sponsor, &instructions, &[&user]).1.unwrap();

    let second = user_with_balances(&mut env.svm);
    let instructions = onboarding_ixs(&env.svm, second.pubkey(), sponsor.pubkey(), &default_enroll_params());
    let failure = send_many(&mut env, &sponsor, &instructions, &[&second]).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::BetaFull.into()));
}

type Mutation = fn(&mut laterite::EnrollParams);

#[test]
fn invalid_settings_are_rejected() {
    let cases: [(Mutation, LateriteError); 7] = [
        (|p| p.tier = 2, LateriteError::InvalidTier),
        (|p| p.asset = 2, LateriteError::UnknownAsset),
        (|p| p.payment_tokens = 0, LateriteError::NoPaymentToken),
        (|p| p.payment_tokens = 0b100, LateriteError::UnknownPaymentToken),
        (|p| p.change_multiplier = 4, LateriteError::InvalidRules),
        (|p| p.engine_amount = 30_000_000, LateriteError::InvalidRules),
        (
            |p| {
                p.engine_amount = 0;
                p.income_rule = false;
                p.change_multiplier = 0;
            },
            LateriteError::InvalidRules,
        ),
    ];
    for (mutate, expected) in cases {
        let mut env = with_plans();
        let sponsor = sponsor();
        let user = user_with_balances(&mut env.svm);
        let mut instructions = onboarding_ixs(&env.svm, user.pubkey(), sponsor.pubkey(), &default_enroll_params());
        let mut params = default_enroll_params();
        mutate(&mut params);
        let subscriptions = [subscription_address(0, 0, &user.pubkey()), subscription_address(1, 0, &user.pubkey())];
        *instructions.last_mut().unwrap() = enroll_ix(user.pubkey(), sponsor.pubkey(), params, &subscriptions);
        let failure = send_many(&mut env, &sponsor, &instructions, &[&user]).1.unwrap_err();
        assert_eq!(custom_code(&failure), Some(expected.into()), "{expected:?}");
    }
}

#[test]
fn each_enabled_token_needs_its_subscription_to_the_tier() {
    let mut env = with_plans();
    let sponsor = sponsor();
    let user = user_with_balances(&mut env.svm);
    let usdc_only = laterite::EnrollParams { payment_tokens: 0b01, ..default_enroll_params() };
    let mut instructions = onboarding_ixs(&env.svm, user.pubkey(), sponsor.pubkey(), &usdc_only);
    instructions.pop();

    let user_key = user.pubkey();
    let cases = [
        // USDT enabled, but only a USDC subscription exists.
        (default_enroll_params(), vec![subscription_address(0, 0, &user_key), subscription_address(0, 0, &user_key)]),
        // Subscribed at $10, enrolling at $25.
        (laterite::EnrollParams { tier: 1, ..usdc_only.clone() }, vec![subscription_address(0, 0, &user_key)]),
        // No subscription passed.
        (usdc_only.clone(), vec![]),
    ];
    for (params, subscriptions) in cases {
        let mut attempt = instructions.clone();
        attempt.push(enroll_ix(user_key, sponsor.pubkey(), params, &subscriptions));
        let failure = send_many(&mut env, &sponsor, &attempt, &[&user]).1.unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::SubscriptionMismatch.into()));
    }

    // A cancelled subscription is not live, even though the account stays open at its canonical address.
    send_many(&mut env, &sponsor, &instructions, &[&user]).1.unwrap();
    let cancel = cancel_subscription_ix(0, 0, user_key);
    send(&mut env.svm, &sponsor, cancel, &[&user]).unwrap();
    let attempt = enroll_ix(user_key, sponsor.pubkey(), usdc_only, &[subscription_address(0, 0, &user_key)]);
    let failure = send(&mut env.svm, &sponsor, attempt, &[&user]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::SubscriptionMismatch.into()));
}

#[test]
fn the_user_must_sign() {
    let mut env = with_plans();
    let sponsor = sponsor();
    let user = user_with_balances(&mut env.svm);
    let mut instruction = enroll_ix(user.pubkey(), sponsor.pubkey(), default_enroll_params(), &[]);
    instruction.accounts[0].is_signer = false;
    let failure = send(&mut env.svm, &sponsor, instruction, &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(anchor_lang::error::ErrorCode::AccountNotSigner.into()));
}
