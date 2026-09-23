//! A router for the program tests. It runs the instructions its data encodes, in order, passing each the accounts
//! it names with the privileges this instruction received, so a test can compose any route a caller could, honest or
//! not, and have the sweep's swap authority sign it.

use {
    solana_account_info::AccountInfo,
    solana_cpi::invoke,
    solana_instruction::{AccountMeta, Instruction},
    solana_program_entrypoint::{entrypoint, ProgramResult},
    solana_program_error::ProgramError,
    solana_pubkey::Pubkey,
};

entrypoint!(process_instruction);

/// Each instruction is encoded as the index of its program among the accounts, its account count, the index of each
/// account, a `u16` data length and the data.
fn process_instruction(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let account = |index: u8| accounts.get(usize::from(index)).ok_or(ProgramError::NotEnoughAccountKeys);
    let mut rest = data;
    while let Some((&program, tail)) = rest.split_first() {
        let (&count, tail) = tail.split_first().ok_or(ProgramError::InvalidInstructionData)?;
        let (indexes, tail) = tail.split_at_checked(usize::from(count)).ok_or(ProgramError::InvalidInstructionData)?;
        let (len, tail) = tail.split_first_chunk::<2>().ok_or(ProgramError::InvalidInstructionData)?;
        let (data, tail) =
            tail.split_at_checked(usize::from(u16::from_le_bytes(*len))).ok_or(ProgramError::InvalidInstructionData)?;
        let metas = indexes
            .iter()
            .map(|&index| {
                let info = account(index)?;
                Ok(AccountMeta { pubkey: *info.key, is_signer: info.is_signer, is_writable: info.is_writable })
            })
            .collect::<Result<Vec<_>, ProgramError>>()?;
        invoke(&Instruction { program_id: *account(program)?.key, accounts: metas, data: data.to_vec() }, accounts)?;
        rest = tail;
    }
    Ok(())
}
