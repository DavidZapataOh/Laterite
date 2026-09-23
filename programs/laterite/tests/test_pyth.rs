mod common;

use {
    anchor_lang::solana_program::{instruction::Instruction, pubkey::Pubkey},
    common::*,
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

type Outcome = Result<TransactionMetadata, FailedTransactionMetadata>;

/// Both clusters' Pyth Pro, with their names; devnet is where the product runs.
const DEPLOYMENTS: [(&str, PythDeployment); 2] = [("mainnet", PYTH_MAINNET), ("devnet", PYTH_DEVNET)];

/// Sends `instructions` in one legacy transaction; returns its size too.
fn send_all(svm: &mut LiteSVM, payer: &Keypair, instructions: &[Instruction]) -> (usize, Outcome) {
    let message = Message::new_with_blockhash(instructions, Some(&payer.pubkey()), &svm.latest_blockhash());
    let transaction = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[payer]).unwrap();
    let size = bincode::serialize(&transaction).unwrap().len();
    let result = svm.send_transaction(transaction);
    svm.expire_blockhash();
    (size, result)
}

/// One ed25519 instruction signing every message, then one `verify_message` per message.
fn verify(svm: &mut LiteSVM, payer: &Keypair, treasury: Pubkey, messages: &[&[u8]]) -> (usize, Outcome) {
    let signatures: Vec<_> = (1..).zip(messages).map(|(index, message)| (*message, index, 12)).collect();
    let mut instructions = vec![ed25519_ix(&signatures)];
    instructions.extend(
        (0..)
            .zip(messages)
            .map(|(signature, message)| verify_message_ix(payer.pubkey(), treasury, message, 0, signature)),
    );
    send_all(svm, payer, &instructions)
}

fn pyth(deployment: &PythDeployment) -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    add_pyth(&mut svm, deployment);
    let payer = funded(&mut svm);
    (svm, payer)
}

/// Compute units of each Pyth Pro invocation, in order.
fn pyth_units(meta: &TransactionMetadata) -> Vec<u64> {
    let prefix = format!("Program {PYTH_PRO_ID} consumed ");
    meta.logs.iter().filter_map(|line| line.strip_prefix(&prefix)?.split(' ').next()?.parse().ok()).collect()
}

#[test]
fn real_updates_verify_against_the_production_signer() {
    for (cluster, deployment) in &DEPLOYMENTS {
        let (mut svm, payer) = pyth(deployment);
        for update in [PYTH_SPYX_QQQX, PYTH_USDT] {
            let before = svm.get_balance(&deployment.treasury).unwrap();
            let (size, result) = verify(&mut svm, &payer, deployment.treasury, &[update]);
            let meta = result.unwrap();
            assert_eq!(svm.get_balance(&deployment.treasury).unwrap(), before + 1, "the fee is 1 lamport");
            println!("{cluster}: update {} B, transaction {size} B, Pyth Pro {:?} CU", update.len(), pyth_units(&meta));
        }
    }
}

#[test]
fn two_updates_verify_as_two_signatures_of_one_ed25519_instruction() {
    for (cluster, deployment) in &DEPLOYMENTS {
        let (mut svm, payer) = pyth(deployment);
        let treasury = svm.get_balance(&deployment.treasury).unwrap();
        let balance = svm.get_balance(&payer.pubkey()).unwrap();
        let (size, result) = verify(&mut svm, &payer, deployment.treasury, &[PYTH_SPYX_QQQX, PYTH_USDT]);
        let meta = result.unwrap();
        assert_eq!(svm.get_balance(&deployment.treasury).unwrap(), treasury + 2, "1 lamport per update");
        let fee = balance - svm.get_balance(&payer.pubkey()).unwrap() - 2;
        assert_eq!(fee, 15_000, "the transaction's signature and both precompile signatures");
        println!(
            "{cluster}: updates {} + {} B, transaction {size} B, Pyth Pro {:?} CU, fee {fee} lamports",
            PYTH_SPYX_QQQX.len(),
            PYTH_USDT.len(),
            pyth_units(&meta)
        );
    }
}

#[test]
fn each_verification_is_bound_to_its_own_signature() {
    for (_, deployment) in &DEPLOYMENTS {
        let (mut svm, payer) = pyth(deployment);
        let instructions = [
            ed25519_ix(&[(PYTH_SPYX_QQQX, 1, 12), (PYTH_USDT, 2, 12)]),
            verify_message_ix(payer.pubkey(), deployment.treasury, PYTH_SPYX_QQQX, 0, 1),
            verify_message_ix(payer.pubkey(), deployment.treasury, PYTH_USDT, 0, 0),
        ];
        let failure = send_all(&mut svm, &payer, &instructions).1.unwrap_err();
        assert_eq!(failure.err, TransactionError::InstructionError(1, InstructionError::InvalidInstructionData));
        assert!(failure.meta.logs.iter().any(|line| line.contains("InvalidMessageData")));
    }
}

#[test]
fn a_tampered_update_fails_the_signature_check() {
    for (_, deployment) in &DEPLOYMENTS {
        let (mut svm, payer) = pyth(deployment);
        let mut update = PYTH_SPYX_QQQX.to_vec();
        *update.last_mut().unwrap() ^= 1;
        let failure = verify(&mut svm, &payer, deployment.treasury, &[&update]).1.unwrap_err();
        assert!(matches!(failure.err, TransactionError::InstructionError(0, _)), "{:?}", failure.err);
    }
}

#[test]
fn an_untrusted_signer_is_refused() {
    for (_, deployment) in &DEPLOYMENTS {
        let (mut svm, payer) = pyth(deployment);
        let update = signed_by(PYTH_USDT, &Keypair::new());
        let failure = verify(&mut svm, &payer, deployment.treasury, &[&update]).1.unwrap_err();
        assert_eq!(failure.err, TransactionError::InstructionError(1, InstructionError::MissingRequiredSignature));
        assert!(failure.meta.logs.iter().any(|line| line.contains("NotTrustedSigner")));
    }
}

#[test]
fn only_the_stored_treasury_takes_the_fee() {
    // The other cluster's treasury: the likely misconfiguration.
    for ((_, deployment), (_, other)) in DEPLOYMENTS.iter().zip(DEPLOYMENTS.iter().rev()) {
        let (mut svm, payer) = pyth(deployment);
        svm.airdrop(&other.treasury, 1_000_000_000).unwrap();
        let failure = verify(&mut svm, &payer, other.treasury, &[PYTH_SPYX_QQQX]).1.unwrap_err();
        assert!(matches!(failure.err, TransactionError::InstructionError(1, _)), "{:?}", failure.err);
    }
}
