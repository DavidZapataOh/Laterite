use anchor_lang::prelude::*;
use solana_instructions_sysvar::get_instruction_relative;
use solana_sdk_ids::{ed25519_program, sysvar};

use crate::{
    errors::LateriteError, events::Attested, Attestation, AttestationRecord, Config, EventKind, UserConfig, UserStatus,
    ATTESTATION_DOMAIN, ATTESTATION_SEED, ATTESTATION_TTL_SECONDS, CONFIG_SEED, PAYMENT_TOKEN_COUNT, USER_CONFIG_SEED,
};

/// Where the ed25519 precompile's standard single-signature layout puts the public key, the signature and the
/// message, all inside its own data.
const PUBLIC_KEY_OFFSET: u16 = 16;
const SIGNATURE_OFFSET: u16 = PUBLIC_KEY_OFFSET + 32;
const MESSAGE_OFFSET: u16 = SIGNATURE_OFFSET + 64;

#[derive(Accounts)]
#[instruction(attestation: Attestation)]
pub struct Attest<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [USER_CONFIG_SEED, attestation.user.as_ref()], bump = user_config.bump)]
    pub user_config: Account<'info, UserConfig>,
    #[account(
        init,
        payer = payer,
        space = 8 + AttestationRecord::INIT_SPACE,
        seeds = [
            ATTESTATION_SEED,
            attestation.user.as_ref(),
            &attestation.signature[..32],
            &attestation.signature[32..],
            &attestation.transfer_index.to_le_bytes(),
        ],
        bump
    )]
    pub record: Account<'info, AttestationRecord>,
    /// CHECK: the instructions sysvar, checked by address.
    #[account(address = sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl Attest<'_> {
    pub fn attest(&mut self, attestation: Attestation) -> Result<()> {
        let mut message = Vec::with_capacity(ATTESTATION_DOMAIN.len() + 64 + Attestation::INIT_SPACE);
        message.extend_from_slice(ATTESTATION_DOMAIN);
        message.extend_from_slice(crate::ID.as_ref());
        message.extend_from_slice(&self.config.genesis_hash);
        attestation.serialize(&mut message)?;
        verify_signature(&self.instructions, &self.config.attestor, &message)?;

        let now = Clock::get()?.unix_timestamp;
        let user_config = &mut self.user_config;
        require!(user_config.status == UserStatus::Active, LateriteError::UserNotActive);
        require!(
            attestation.amount > 0 && (user_config.attestable_from..=now).contains(&attestation.event_time),
            LateriteError::InvalidAttestation
        );
        require_gte!(attestation.event_time + ATTESTATION_TTL_SECONDS, now, LateriteError::AttestationExpired);
        let token = usize::from(attestation.payment_token);
        require!(
            token < PAYMENT_TOKEN_COUNT && user_config.payment_tokens & (1 << token) != 0,
            LateriteError::UnknownPaymentToken
        );

        let invested = match attestation.kind {
            EventKind::Income => user_config.income_share(attestation.amount),
            EventKind::Payment => user_config.change(attestation.amount),
        };
        require_gt!(invested, 0, LateriteError::NothingToInvest);
        user_config.pending = user_config.pending.saturating_add(invested);
        self.record.set_inner(AttestationRecord {
            payer: self.payer.key(),
            expires_at: attestation.event_time + ATTESTATION_TTL_SECONDS,
        });

        emit!(Attested { attestation, invested, pending: user_config.pending });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CloseAttestation<'info> {
    #[account(mut, close = payer, has_one = payer)]
    pub record: Account<'info, AttestationRecord>,
    #[account(mut)]
    pub payer: SystemAccount<'info>,
}

impl CloseAttestation<'_> {
    pub fn close_attestation(&mut self) -> Result<()> {
        require_gt!(Clock::get()?.unix_timestamp, self.record.expires_at, LateriteError::AttestationNotExpired);
        Ok(())
    }
}

/// The previous instruction must be the ed25519 precompile checking exactly one signature by `attestor` over
/// `message`, laid out as `new_ed25519_instruction_with_signature` does: every offset inside its own data, so no other
/// instruction's bytes can stand in for them.
fn verify_signature(instructions: &AccountInfo, attestor: &Pubkey, message: &[u8]) -> Result<()> {
    let instruction =
        get_instruction_relative(-1, instructions).map_err(|_| LateriteError::InvalidAttestationSignature)?;
    let here = u16::MAX;
    let header = [SIGNATURE_OFFSET, here, PUBLIC_KEY_OFFSET, here, MESSAGE_OFFSET, message.len() as u16, here];
    let data = &instruction.data;
    let valid = instruction.program_id == ed25519_program::ID
        && data.len() == usize::from(MESSAGE_OFFSET) + message.len()
        && data[..2] == [1, 0]
        && data[2..16].chunks_exact(2).zip(header).all(|(bytes, value)| bytes == value.to_le_bytes())
        && data[usize::from(PUBLIC_KEY_OFFSET)..usize::from(SIGNATURE_OFFSET)] == attestor.to_bytes()
        && data[usize::from(MESSAGE_OFFSET)..] == *message;
    require!(valid, LateriteError::InvalidAttestationSignature);
    Ok(())
}
