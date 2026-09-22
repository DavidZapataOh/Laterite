mod common;

use {anchor_lang::solana_program::pubkey::Pubkey, common::*, laterite::LateriteError, solana_signer::Signer};

#[test]
fn the_proposed_admin_takes_over_on_accept() {
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    let successor = funded(&mut env.svm);

    send(&mut env.svm, &admin, propose_admin_ix(admin.pubkey(), successor.pubkey()), &[]).unwrap();
    assert_eq!(fetch_config(&env.svm).pending_admin, successor.pubkey());
    assert_eq!(fetch_config(&env.svm).admin, admin.pubkey());

    send(&mut env.svm, &successor, accept_admin_ix(successor.pubkey()), &[]).unwrap();
    let config = fetch_config(&env.svm);
    assert_eq!(config.admin, successor.pubkey());
    assert_eq!(config.pending_admin, Pubkey::default());

    let failure = send(&mut env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::Unauthorized.into()));
    send(&mut env.svm, &successor, set_paused_ix(successor.pubkey(), true), &[]).unwrap();
}

#[test]
fn only_the_pending_admin_can_accept() {
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    let successor = funded(&mut env.svm);
    let intruder = funded(&mut env.svm);
    send(&mut env.svm, &admin, propose_admin_ix(admin.pubkey(), successor.pubkey()), &[]).unwrap();

    let failure = send(&mut env.svm, &intruder, accept_admin_ix(intruder.pubkey()), &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::NotPendingAdmin.into()));
    assert_eq!(fetch_config(&env.svm).admin, admin.pubkey());
}

#[test]
fn proposing_the_default_key_cancels_the_handover() {
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    let successor = funded(&mut env.svm);
    send(&mut env.svm, &admin, propose_admin_ix(admin.pubkey(), successor.pubkey()), &[]).unwrap();
    send(&mut env.svm, &admin, propose_admin_ix(admin.pubkey(), Pubkey::default()), &[]).unwrap();

    let failure = send(&mut env.svm, &successor, accept_admin_ix(successor.pubkey()), &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::NotPendingAdmin.into()));
}
