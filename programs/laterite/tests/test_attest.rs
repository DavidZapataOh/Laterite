mod common;

use {
    anchor_lang::{solana_program::pubkey::Pubkey, AccountDeserialize},
    common::*,
    laterite::{
        Attestation, AttestationRecord, EnrollParams, EventKind, LateriteError, Settings, UserConfig, UserStatus,
        ATTESTATION_TTL_SECONDS,
    },
    solana_compute_budget_interface::ComputeBudgetInstruction,
    solana_keypair::Keypair,
    solana_signer::Signer,
    solana_system_interface::error::SystemError,
    std::collections::BTreeMap,
};

const ENROLLED_AT: i64 = NOW;
const EVENT_AT: i64 = NOW + 60;
const DOLLAR: u64 = 1_000_000;

fn rules() -> EnrollParams {
    EnrollParams { income_rule: true, change_multiplier: 1, ..default_enroll_params() }
}

fn attestation(kind: EventKind, user: Pubkey, amount: u64, tag: u8) -> Attestation {
    Attestation { kind, user, payment_token: 0, amount, event_time: EVENT_AT, signature: [tag; 64], transfer_index: 0 }
}

/// A user enrolled with `params` under a fixed key, so compute units repeat on every run; the clock two minutes
/// after enrollment; a funded submitter.
fn setup(params: &EnrollParams) -> (Env, Keypair, Keypair) {
    let mut env = with_plans();
    let user = enrolled(&mut env, Keypair::new_from_array([9; 32]), params);
    set_now(&mut env.svm, NOW + 120);
    let payer = funded(&mut env.svm);
    (env, user, payer)
}

fn record(env: &Env, attestation: &Attestation) -> Option<AttestationRecord> {
    let account = env.svm.get_account(&attestation_record_address(attestation))?;
    AttestationRecord::try_deserialize(&mut account.data.as_slice()).ok()
}

#[test]
fn an_income_counts_once() {
    let (mut env, user, payer) = setup(&rules());
    let income = attestation(EventKind::Income, user.pubkey(), 1_500 * DOLLAR, 1);

    let (size, result) = send_many(&mut env, &payer, &attest_ixs(payer.pubkey(), &income, &attestor()), &[]);
    println!("attest: transaction {size} B, {} CU", result.unwrap().compute_units_consumed);
    assert_eq!(fetch_user_config(&env, &user.pubkey()).pending, 150 * DOLLAR);
    let record = record(&env, &income).unwrap();
    assert_eq!(record.payer, payer.pubkey());
    assert_eq!(record.expires_at, EVENT_AT + ATTESTATION_TTL_SECONDS);

    // The same transfer, correctly signed again, as is or with any field outside its identity changed.
    let resigned = [
        income.clone(),
        Attestation { amount: 2_000 * DOLLAR, ..income.clone() },
        Attestation { kind: EventKind::Payment, ..income.clone() },
        Attestation { event_time: EVENT_AT + 1, ..income.clone() },
    ];
    for attestation in resigned {
        let failure = submit_attestation(&mut env, &payer, &attestation, &attestor()).unwrap_err();
        assert_eq!(custom_code(&failure), Some(SystemError::AccountAlreadyInUse as u32));
    }
    assert_eq!(fetch_user_config(&env, &user.pubkey()).pending, 150 * DOLLAR);
}

/// The record's canonical bump search costs one `create_program_address` per try, and the first try succeeds about
/// half the time, so the expected cost is about two tries.
#[test]
fn attest_compute_units_follow_the_bump_search() {
    let (mut env, user, payer) = setup(&rules());
    let mut by_tries = BTreeMap::<u8, (u64, u32)>::new();
    let mut total = 0;
    for tag in 0..=u8::MAX {
        let income = attestation(EventKind::Income, user.pubkey(), 100 * DOLLAR, tag);
        let tries = u8::MAX - find_attestation_record(&income).1 + 1;
        let units = submit_attestation(&mut env, &payer, &income, &attestor()).unwrap();
        let (class_units, count) = by_tries.entry(tries).or_insert((units, 0));
        assert_eq!(*class_units, units);
        *count += 1;
        total += units;
    }
    let first_try = by_tries[&1].0;
    for (&tries, &(units, count)) in &by_tries {
        println!("attest, bump found on try {tries}: {units} CU ({count} of 256 transfers)");
        assert_eq!(units, first_try + 1_500 * u64::from(tries - 1));
    }
    println!("attest, mean over 256 transfers: {} CU", total / 256);
}

#[test]
fn a_payment_adds_its_change() {
    let (mut env, user, payer) = setup(&EnrollParams { change_multiplier: 3, ..rules() });
    submit_attestation(&mut env, &payer, &attestation(EventKind::Payment, user.pubkey(), 12_340_000, 1), &attestor())
        .unwrap();
    submit_attestation(&mut env, &payer, &attestation(EventKind::Payment, user.pubkey(), 20 * DOLLAR, 2), &attestor())
        .unwrap();
    assert_eq!(fetch_user_config(&env, &user.pubkey()).pending, 3 * 660_000 + 3 * 500_000);
}

#[test]
fn the_kill_switch_does_not_stop_attesting() {
    let (mut env, user, payer) = setup(&rules());
    let admin = env.authority.insecure_clone();
    send(&mut env.svm, &admin, set_paused_ix(admin.pubkey(), true), &[]).unwrap();
    submit_attestation(&mut env, &payer, &attestation(EventKind::Income, user.pubkey(), 100 * DOLLAR, 1), &attestor())
        .unwrap();
    assert_eq!(fetch_user_config(&env, &user.pubkey()).pending, 10 * DOLLAR);
}

#[test]
fn an_event_the_rules_ignore_is_refused() {
    let (mut env, user, payer) = setup(&EnrollParams { income_rule: false, change_multiplier: 0, ..rules() });
    for event in [
        attestation(EventKind::Income, user.pubkey(), 1_500 * DOLLAR, 1),
        attestation(EventKind::Payment, user.pubkey(), 12 * DOLLAR, 2),
    ] {
        let failure = submit_attestation(&mut env, &payer, &event, &attestor()).unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::NothingToInvest.into()));
    }

    let (mut env, user, payer) = setup(&rules());
    let small = attestation(EventKind::Income, user.pubkey(), 49_999_999, 3);
    let failure = submit_attestation(&mut env, &payer, &small, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::NothingToInvest.into()));
}

#[test]
fn only_the_attestors_signature_over_the_same_attestation_counts() {
    let (mut env, user, payer) = setup(&rules());
    let income = attestation(EventKind::Income, user.pubkey(), 1_500 * DOLLAR, 1);

    let failure = submit_attestation(&mut env, &payer, &income, &Keypair::new()).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidAttestationSignature.into()));

    let signed = attest_ixs(payer.pubkey(), &income, &attestor());
    let other_user = enrolled(&mut env, Keypair::new(), &rules()).pubkey();
    let altered = [
        Attestation { amount: 15_000 * DOLLAR, ..income.clone() },
        Attestation { kind: EventKind::Payment, ..income.clone() },
        Attestation { user: other_user, ..income.clone() },
        Attestation { transfer_index: 1, ..income.clone() },
    ];
    for attestation in altered {
        let instructions = [signed[0].clone(), attest_ix(payer.pubkey(), &attestation)];
        let failure = send_many(&mut env, &payer, &instructions, &[]).1.unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::InvalidAttestationSignature.into()));
    }

    let in_between = ComputeBudgetInstruction::set_compute_unit_price(1);
    for instructions in [vec![signed[1].clone()], vec![signed[0].clone(), in_between, signed[1].clone()]] {
        let failure = send_many(&mut env, &payer, &instructions, &[]).1.unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::InvalidAttestationSignature.into()));
    }
    assert_eq!(fetch_user_config(&env, &user.pubkey()).pending, 0);
}

#[test]
fn an_attestation_signed_for_another_deployment_is_refused() {
    let (mut env, user, payer) = setup(&rules());
    let income = attestation(EventKind::Income, user.pubkey(), 1_500 * DOLLAR, 1);
    // The same attestor key, over the same attestation, for devnet or for another program on this cluster.
    for (program, genesis_hash) in [(laterite::ID, DEVNET_GENESIS_HASH), (Pubkey::new_unique(), MAINNET_GENESIS_HASH)] {
        let message = attestation_message(&program, &genesis_hash, &income);
        let instructions = [signature_ix(&message, &attestor()), attest_ix(payer.pubkey(), &income)];
        let failure = send_many(&mut env, &payer, &instructions, &[]).1.unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::InvalidAttestationSignature.into()));
    }
    submit_attestation(&mut env, &payer, &income, &attestor()).unwrap();
}

#[test]
fn a_rotated_attestor_key_stops_counting_and_events_stay_deduplicated() {
    let (mut env, user, payer) = setup(&rules());
    let first = attestation(EventKind::Income, user.pubkey(), 1_000 * DOLLAR, 1);
    submit_attestation(&mut env, &payer, &first, &attestor()).unwrap();

    let rotated = Keypair::new();
    let settings = Settings { attestor: rotated.pubkey(), ..valid_params().settings };
    let admin = env.authority.insecure_clone();
    send(&mut env.svm, &admin, update_config_ix(admin.pubkey(), settings), &[]).unwrap();

    assert!(submit_attestation(&mut env, &payer, &first, &rotated).is_err());
    let second = attestation(EventKind::Income, user.pubkey(), 1_000 * DOLLAR, 2);
    let failure = submit_attestation(&mut env, &payer, &second, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidAttestationSignature.into()));
    submit_attestation(&mut env, &payer, &second, &rotated).unwrap();
    assert_eq!(fetch_user_config(&env, &user.pubkey()).pending, 200 * DOLLAR);
}

#[test]
fn an_event_outside_the_window_is_refused() {
    let (mut env, user, payer) = setup(&rules());
    let income = attestation(EventKind::Income, user.pubkey(), 1_500 * DOLLAR, 1);
    let cases = [
        (Attestation { amount: 0, ..income.clone() }, LateriteError::InvalidAttestation),
        (Attestation { event_time: ENROLLED_AT - 1, ..income.clone() }, LateriteError::InvalidAttestation),
        (Attestation { event_time: NOW + 121, ..income.clone() }, LateriteError::InvalidAttestation),
    ];
    for (attestation, error) in cases {
        let failure = submit_attestation(&mut env, &payer, &attestation, &attestor()).unwrap_err();
        assert_eq!(custom_code(&failure), Some(error.into()));
    }

    set_now(&mut env.svm, EVENT_AT + ATTESTATION_TTL_SECONDS + 1);
    let failure = submit_attestation(&mut env, &payer, &income, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::AttestationExpired.into()));
    set_now(&mut env.svm, EVENT_AT + ATTESTATION_TTL_SECONDS);
    submit_attestation(&mut env, &payer, &income, &attestor()).unwrap();
}

#[test]
fn only_an_active_user_is_credited_and_only_from_their_latest_start() {
    let (mut env, user, payer) = setup(&rules());
    let active = fetch_user_config(&env, &user.pubkey());
    let income = attestation(EventKind::Income, user.pubkey(), 1_500 * DOLLAR, 1);
    for status in [UserStatus::Paused, UserStatus::Exited] {
        write_user_config(&mut env, &UserConfig { status, ..active.clone() });
        let failure = submit_attestation(&mut env, &payer, &income, &attestor()).unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::UserNotActive.into()));
        assert!(record(&env, &income).is_none());
    }

    // Active again from NOW + 90, after a resume or a reactivation: an earlier transfer never counts.
    write_user_config(&mut env, &UserConfig { attestable_from: NOW + 90, ..active });
    let failure = submit_attestation(&mut env, &payer, &income, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidAttestation.into()));
    submit_attestation(&mut env, &payer, &Attestation { event_time: NOW + 90, ..income }, &attestor()).unwrap();
    assert_eq!(fetch_user_config(&env, &user.pubkey()).pending, 150 * DOLLAR);
}

#[test]
fn only_an_enabled_payment_token_counts() {
    let (mut env, user, payer) = setup(&EnrollParams { payment_tokens: 0b01, ..rules() });
    for payment_token in [1, 2, 255] {
        let usdt = Attestation { payment_token, ..attestation(EventKind::Income, user.pubkey(), 1_500 * DOLLAR, 1) };
        let failure = submit_attestation(&mut env, &payer, &usdt, &attestor()).unwrap_err();
        assert_eq!(custom_code(&failure), Some(LateriteError::UnknownPaymentToken.into()));
    }
}

#[test]
fn pending_saturates() {
    let (mut env, user, payer) = setup(&rules());
    let mut user_config = fetch_user_config(&env, &user.pubkey());
    user_config.pending = u64::MAX - 1;
    write_user_config(&mut env, &user_config);
    submit_attestation(
        &mut env,
        &payer,
        &attestation(EventKind::Income, user.pubkey(), 1_500 * DOLLAR, 1),
        &attestor(),
    )
    .unwrap();
    assert_eq!(fetch_user_config(&env, &user.pubkey()).pending, u64::MAX);
}

#[test]
fn an_expired_record_closes_to_its_payer() {
    let (mut env, user, payer) = setup(&rules());
    let income = attestation(EventKind::Income, user.pubkey(), 1_500 * DOLLAR, 1);
    submit_attestation(&mut env, &payer, &income, &attestor()).unwrap();
    let address = attestation_record_address(&income);
    let rent = env.svm.get_balance(&address).unwrap();
    let closer = funded(&mut env.svm);

    set_now(&mut env.svm, EVENT_AT + ATTESTATION_TTL_SECONDS);
    let failure = send(&mut env.svm, &closer, close_attestation_ix(address, payer.pubkey()), &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::AttestationNotExpired.into()));
    set_now(&mut env.svm, EVENT_AT + ATTESTATION_TTL_SECONDS + 1);
    let stranger = Keypair::new().pubkey();
    let failure = send(&mut env.svm, &closer, close_attestation_ix(address, stranger), &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(anchor_lang::error::ErrorCode::ConstraintHasOne.into()));

    let before = env.svm.get_balance(&payer.pubkey()).unwrap();
    let result = send(&mut env.svm, &closer, close_attestation_ix(address, payer.pubkey()), &[]).unwrap();
    println!("close_attestation: {} CU; record rent: {rent} lamports", result.compute_units_consumed);
    assert_eq!(env.svm.get_balance(&payer.pubkey()).unwrap(), before + rent);
    assert!(env.svm.get_account(&address).is_none_or(|account| account.lamports == 0));

    let failure = submit_attestation(&mut env, &payer, &income, &attestor()).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::AttestationExpired.into()));
}

#[test]
fn each_attestation_needs_its_own_signature_instruction() {
    let (mut env, user, payer) = setup(&rules());
    let first = attestation(EventKind::Income, user.pubkey(), 1_000 * DOLLAR, 1);
    let second = attestation(EventKind::Income, user.pubkey(), 1_000 * DOLLAR, 2);
    let mut both = attest_ixs(payer.pubkey(), &first, &attestor()).to_vec();
    both.extend(attest_ixs(payer.pubkey(), &second, &attestor()));
    send_many(&mut env, &payer, &both, &[]).1.unwrap();
    assert_eq!(fetch_user_config(&env, &user.pubkey()).pending, 200 * DOLLAR);

    let third = attestation(EventKind::Income, user.pubkey(), 1_000 * DOLLAR, 3);
    let fourth = attestation(EventKind::Income, user.pubkey(), 1_000 * DOLLAR, 4);
    let mut reused = attest_ixs(payer.pubkey(), &third, &attestor()).to_vec();
    reused.push(attest_ix(payer.pubkey(), &fourth));
    let failure = send_many(&mut env, &payer, &reused, &[]).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidAttestationSignature.into()));
}

#[test]
fn a_signature_instruction_outside_the_standard_layout_is_refused() {
    let (mut env, user, payer) = setup(&rules());
    let income = attestation(EventKind::Income, user.pubkey(), 1_500 * DOLLAR, 1);
    let [mut ed25519, attest] = attest_ixs(payer.pubkey(), &income, &attestor());
    // The same bytes, addressed by the instruction's own index (0) instead of "this instruction": the precompile
    // still verifies them, but the program accepts only the standard layout.
    for index in [4, 8, 14] {
        ed25519.data[index..index + 2].copy_from_slice(&0u16.to_le_bytes());
    }
    let failure = send_many(&mut env, &payer, &[ed25519, attest], &[]).1.unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidAttestationSignature.into()));
}
