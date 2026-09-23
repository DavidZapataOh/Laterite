mod common;

use {
    anchor_lang::{solana_program::pubkey::Pubkey, Space},
    common::*,
    laterite::{Config, ConfigParams, LateriteError, VAULT_SEED},
    solana_signer::Signer,
};

#[test]
fn config_is_833_bytes() {
    assert_eq!(8 + Config::INIT_SPACE, 833);
}

#[test]
fn upgrade_authority_initializes_the_config() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let params = valid_params();
    send(&mut env.svm, &authority, initialize_ix(authority.pubkey(), params.clone()), &[]).unwrap();

    let config = fetch_config(&env.svm);
    assert_eq!(config.admin, authority.pubkey());
    assert_eq!(config.pending_admin, Pubkey::default());
    assert!(!config.paused);
    assert_eq!(config.router, params.settings.router);
    assert_eq!(config.attestor, params.settings.attestor);
    assert_eq!(config.sponsor, sponsor().pubkey());
    assert_eq!(config.user_weekly_cap, 25_000_000);
    assert_eq!(config.max_users, 100);
    assert_eq!(config.user_count, 0);
    assert_eq!(config.assets, params.assets);
    assert_eq!(config.payment_tokens, params.payment_tokens);
    assert_eq!(config.vault_bump, Pubkey::find_program_address(&[VAULT_SEED], &laterite::ID).1);
}

#[test]
fn any_other_signer_is_rejected() {
    let mut env = setup();
    let intruder = funded(&mut env.svm);
    let failure = send(&mut env.svm, &intruder, initialize_ix(intruder.pubkey(), valid_params()), &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::NotUpgradeAuthority.into()));

    // A ProgramData account for a different program, even with the intruder as its upgrade
    // authority, does not bind to `program`: the raw constraint must reject it before the
    // upgrade-authority check ever runs.
    let other_program_data = deploy_with_authority(&mut env.svm, Pubkey::new_unique(), intruder.pubkey());
    let mut instruction = initialize_ix(intruder.pubkey(), valid_params());
    let program_data_meta = instruction.accounts.iter_mut().find(|meta| meta.pubkey == program_data_address()).unwrap();
    program_data_meta.pubkey = other_program_data;
    let failure = send(&mut env.svm, &intruder, instruction, &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(anchor_lang::error::ErrorCode::ConstraintRaw.into()));
}

#[test]
fn the_mint_accounts_are_required() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let mut instruction = initialize_ix(authority.pubkey(), valid_params());
    instruction.accounts.truncate(instruction.accounts.len() - 4);
    let failure = send(&mut env.svm, &authority, instruction, &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(anchor_lang::error::ErrorCode::AccountNotEnoughKeys.into()));

    // A valid mint account in the wrong slot: USDT's account passed where the params still say USDC.
    {
        let mut env = setup();
        let authority = env.authority.insecure_clone();
        let params = valid_params();
        let usdc = params.payment_tokens[0].mint;
        let usdt = params.payment_tokens[1].mint;
        let mut instruction = initialize_ix(authority.pubkey(), params);
        let usdc_meta = instruction.accounts.iter_mut().find(|meta| meta.pubkey == usdc).unwrap();
        usdc_meta.pubkey = usdt;
        let failure = send(&mut env.svm, &authority, instruction, &[]).unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::InvalidPaymentToken.into()));
    }

    // A mint owned by a non-token program, with that same program stated as its token program.
    {
        let mut env = setup();
        let authority = env.authority.insecure_clone();
        let mut params = valid_params();
        let bogus_program = anchor_lang::system_program::ID;
        let mint = Pubkey::new_unique();
        params.payment_tokens[0].mint = mint;
        params.payment_tokens[0].token_program = bogus_program;
        write_mint(&mut env.svm, mint, bogus_program, params.payment_tokens[0].decimals);
        let failure = send(&mut env.svm, &authority, initialize_ix(authority.pubkey(), params), &[]).unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::InvalidPaymentToken.into()));
    }
}

#[test]
fn the_config_is_initialized_once() {
    let mut env = initialized();
    let authority = env.authority.insecure_clone();
    let failure = send(&mut env.svm, &authority, initialize_ix(authority.pubkey(), valid_params()), &[]).unwrap_err();
    // The System Program refuses to create an account that already exists: custom error 0, "already in use".
    assert_eq!(custom_code(&failure), Some(0));
}

type Mutation = fn(&mut ConfigParams);

#[test]
fn invalid_params_are_rejected() {
    let cases: [(Mutation, LateriteError); 10] = [
        (|p| p.settings.router = Pubkey::default(), LateriteError::InvalidRouter),
        (|p| p.settings.attestor = Pubkey::default(), LateriteError::InvalidAttestor),
        (|p| p.settings.sponsor = Pubkey::default(), LateriteError::InvalidSponsor),
        (|p| p.settings.user_weekly_cap = 0, LateriteError::InvalidCap),
        (|p| p.settings.max_users = 0, LateriteError::InvalidCap),
        (|p| p.assets[1].pyth_feed_id = 0, LateriteError::InvalidAsset),
        (|p| p.assets[0].token_program = anchor_spl::token::ID, LateriteError::InvalidAsset),
        (|p| p.assets[0].decimals = 6, LateriteError::InvalidAsset),
        (|p| p.payment_tokens[0].mint = Pubkey::default(), LateriteError::InvalidPaymentToken),
        (|p| p.payment_tokens[1].decimals = 8, LateriteError::InvalidPaymentToken),
    ];
    for (mutate, expected) in cases {
        let mut env = setup();
        let authority = env.authority.insecure_clone();
        let mut params = valid_params();
        mutate(&mut params);
        let failure = send(&mut env.svm, &authority, initialize_ix(authority.pubkey(), params), &[]).unwrap_err();
        assert_eq!(custom_code(&failure), Some(expected.into()), "{expected:?}");
    }
}

#[test]
fn payment_tokens_must_have_six_decimals() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    let mut params = valid_params();
    params.payment_tokens[1].decimals = 9;
    let usdt = params.payment_tokens[1].mint;
    let mut account = env.svm.get_account(&usdt).unwrap();
    // Mint layout: the decimals byte follows the authority (36) and the supply (8).
    account.data[44] = 9;
    env.svm.set_account(usdt, account).unwrap();
    let failure = send(&mut env.svm, &authority, initialize_ix(authority.pubkey(), params), &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidPaymentToken.into()));
}
