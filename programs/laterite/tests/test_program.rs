use {
    anchor_lang::solana_program::instruction::Instruction,
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

const PROGRAM: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/laterite.so"));
const INSTRUCTION_FALLBACK_NOT_FOUND: u32 = 101;

fn svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(laterite::ID, PROGRAM).unwrap();
    svm
}

#[test]
fn program_loads_as_executable() {
    assert!(svm().get_account(&laterite::ID).unwrap().executable);
}

#[test]
fn unknown_instruction_is_rejected_by_the_dispatcher() {
    let mut svm = svm();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let instruction = Instruction::new_with_bytes(laterite::ID, &[0; 8], vec![]);
    let message = Message::new_with_blockhash(&[instruction], Some(&payer.pubkey()), &svm.latest_blockhash());
    let transaction = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[&payer]).unwrap();

    let failure = svm.send_transaction(transaction).unwrap_err();
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(0, InstructionError::Custom(INSTRUCTION_FALLBACK_NOT_FOUND)),
    );
}
