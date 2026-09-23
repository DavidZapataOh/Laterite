mod common;

use {
    anchor_lang::{solana_program::pubkey::Pubkey, AccountSerialize},
    common::*,
    laterite::{Attestation, EnrollParams, EventKind, LateriteError, Settings, ATTESTATION_TTL_SECONDS},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

#[test]
fn admin_updates_settings_and_keeps_the_tables() {
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    let params = valid_params();
    let mut settings = params.settings.clone();
    settings.sponsor = Pubkey::new_unique();
    settings.user_weekly_cap = 10_000_000;
    settings.max_users = 5;
    send(&mut env.svm, &admin, update_config_ix(admin.pubkey(), settings.clone()), &[]).unwrap();

    let config = fetch_config(&env.svm);
    assert_eq!(config.router, params.router);
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

#[test]
fn update_config_changes_only_the_settings() {
    let mut env = with_plans();
    let admin = env.authority.insecure_clone();
    enrolled(&mut env, Keypair::new(), &default_enroll_params());
    send(&mut env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();
    send(&mut env.svm, &admin, propose_admin_ix(admin.pubkey(), Pubkey::new_unique()), &[]).unwrap();
    let before = env.svm.get_account(&config_address()).unwrap().data;

    let settings = Settings {
        attestor: Pubkey::new_unique(),
        sponsor: Pubkey::new_unique(),
        user_weekly_cap: 10_000_000,
        max_users: 1,
    };
    send(&mut env.svm, &admin, update_config_ix(admin.pubkey(), settings.clone()), &[]).unwrap();
    let mut config = fetch_config(&env.svm);
    assert_eq!((config.attestor, config.sponsor, config.max_users), (settings.attestor, settings.sponsor, 1));
    // Putting the old settings back restores every byte: nothing else moved.
    config.apply(&valid_params().settings);
    let mut restored = vec![];
    config.try_serialize(&mut restored).unwrap();
    assert_eq!(restored, before);
}

#[test]
fn the_kill_switch_stops_nothing_but_enrollment_reactivation_and_sweeps() {
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    // Plans are created under the kill switch; enrollment, which it stops, happens with it lifted.
    send(&mut env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();
    let mut env = add_plans(env);
    send(&mut env.svm, &admin, set_paused_ix(admin.pubkey(), false), &[]).unwrap();
    let rules = EnrollParams { income_rule: true, ..default_enroll_params() };
    let user = enrolled(&mut env, Keypair::new(), &rules).pubkey();
    send(&mut env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();

    // Attestations count and expired records close.
    set_now(&mut env.svm, NOW + 120);
    let income = Attestation {
        kind: EventKind::Income,
        user,
        payment_token: 0,
        amount: 100_000_000,
        event_time: NOW + 60,
        signature: [1; 64],
        transfer_index: 0,
    };
    let crank = funded(&mut env.svm);
    submit_attestation(&mut env, &crank, &income, &attestor()).unwrap();
    assert_eq!(fetch_user_config(&env, &user).pending, 10_000_000);
    set_now(&mut env.svm, NOW + 60 + ATTESTATION_TTL_SECONDS + 1);
    send(&mut env.svm, &crank, close_attestation_ix(attestation_record_address(&income), crank.pubkey()), &[]).unwrap();

    // The admin's own instructions keep working, the handover included.
    send(&mut env.svm, &admin, update_config_ix(admin.pubkey(), valid_params().settings), &[]).unwrap();
    let (holidays, early_closes, valid_through) = nyse_calendar();
    let load = set_market_calendar_ix(admin.pubkey(), holidays, early_closes, valid_through);
    send(&mut env.svm, &admin, load, &[]).unwrap();
    let successor = funded(&mut env.svm);
    send(&mut env.svm, &admin, propose_admin_ix(admin.pubkey(), successor.pubkey()), &[]).unwrap();
    send(&mut env.svm, &successor, accept_admin_ix(successor.pubkey()), &[]).unwrap();
    let config = fetch_config(&env.svm);
    assert_eq!((config.admin, config.paused), (successor.pubkey(), true));
}
