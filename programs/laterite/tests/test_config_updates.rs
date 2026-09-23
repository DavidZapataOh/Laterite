mod common;

use {anchor_lang::solana_program::pubkey::Pubkey, common::*, laterite::LateriteError, solana_signer::Signer};

#[test]
fn admin_updates_settings_and_keeps_the_tables() {
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    let params = valid_params();
    let mut settings = params.settings.clone();
    settings.router = Pubkey::new_unique();
    settings.sponsor = Pubkey::new_unique();
    settings.user_weekly_cap = 10_000_000;
    settings.max_users = 5;
    send(&mut env.svm, &admin, update_config_ix(admin.pubkey(), settings.clone()), &[]).unwrap();

    let config = fetch_config(&env.svm);
    assert_eq!(config.router, settings.router);
    assert_eq!(config.sponsor, settings.sponsor);
    assert_eq!(config.user_weekly_cap, 10_000_000);
    assert_eq!(config.max_users, 5);
    assert_eq!(config.assets, params.assets);
    assert_eq!(config.payment_tokens, params.payment_tokens);
    assert_eq!(config.genesis_hash, params.genesis_hash);
    assert_eq!(config.admin, admin.pubkey());
    assert_eq!(config.user_count, 0);
    assert!(!config.paused);
}

#[test]
fn updates_are_validated() {
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    let mut settings = valid_params().settings;
    settings.user_weekly_cap = 0;
    let failure = send(&mut env.svm, &admin, update_config_ix(admin.pubkey(), settings), &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidCap.into()));
}

#[test]
fn admin_toggles_the_kill_switch() {
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    send(&mut env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();
    assert!(fetch_config(&env.svm).paused);
    send(&mut env.svm, &admin, set_paused_ix(admin.pubkey(), false), &[]).unwrap();
    assert!(!fetch_config(&env.svm).paused);
}

#[test]
fn only_the_admin_changes_the_config() {
    let mut env = initialized();
    let intruder = funded(&mut env.svm);
    let attempts = [
        update_config_ix(intruder.pubkey(), valid_params().settings),
        set_paused_ix(intruder.pubkey(), true),
        propose_admin_ix(intruder.pubkey(), intruder.pubkey()),
        set_market_calendar_ix(intruder.pubkey(), vec![], vec![], day((2026, 12, 31))),
    ];
    for instruction in attempts {
        let failure = send(&mut env.svm, &intruder, instruction, &[]).unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::Unauthorized.into()));
    }
}
