//! Laterite: a capped, revocable autopilot from stablecoins into tokenized stocks.

use anchor_lang::prelude::*;

pub mod amount;
pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod market;
pub mod price;
pub mod state;

pub use amount::*;
pub use constants::*;
pub use errors::LateriteError;
pub use instructions::*;
pub use market::*;
pub use price::*;
pub use state::*;

declare_id!("LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf");

#[program]
pub mod laterite {
    use super::*;

    /// Creates the config; only the program's upgrade authority can call it, once. Remaining accounts: the
    /// tables' mint accounts in order, the assets then the payment tokens.
    pub fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
        ctx.accounts.initialize(params, &ctx.bumps, ctx.remaining_accounts)
    }

    /// Replaces the settings: router, attestor, sponsor and beta caps. The tables are fixed at `initialize`.
    pub fn update_config(ctx: Context<AdminOnly>, settings: Settings) -> Result<()> {
        ctx.accounts.update_config(settings)
    }

    /// Kill switch: stops enrollment and sweeps while set.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.set_paused(paused)
    }

    /// Replaces the NYSE calendar the weekly engine follows: full-day holidays and 13:00 early closes, each
    /// ascending, as days since 1970-01-01, and the last day the calendar covers.
    pub fn set_market_calendar(
        ctx: Context<AdminOnly>,
        holidays: Vec<u16>,
        early_closes: Vec<u16>,
        valid_through: u16,
    ) -> Result<()> {
        ctx.accounts.set_market_calendar(holidays, early_closes, valid_through)
    }

    /// First step of an admin handover; `Pubkey::default()` cancels a pending one.
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.propose_admin(new_admin)
    }

    /// Second step: the proposed admin signs to take over.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        ctx.accounts.accept_admin()
    }

    /// Publishes a payment token's weekly tier as a Subscriptions plan owned by the vault authority; the
    /// admin pays its rent, which is not refundable.
    pub fn create_plan(ctx: Context<CreatePlan>, payment_token: u8, tier: u8) -> Result<()> {
        ctx.accounts.create_plan(payment_token, tier)
    }

    /// Creates the user's settings; the configured sponsor pays the rent. Remaining accounts: the user's
    /// subscription to the chosen tier for each enabled payment token, in token order.
    pub fn enroll(ctx: Context<Enroll>, params: EnrollParams) -> Result<()> {
        ctx.accounts.enroll(params, &ctx.bumps, ctx.remaining_accounts)
    }

    /// Adds what the user's rule derives from an attested transfer to their pending amount, once per transfer. The
    /// previous instruction must be the ed25519 precompile verifying the attestor's signature over the attestation
    /// for this deployment. Anyone can submit it; the payer funds the record and gets it back on close.
    pub fn attest(ctx: Context<Attest>, attestation: Attestation) -> Result<()> {
        ctx.accounts.attest(attestation)
    }

    /// Closes an expired attestation record, refunding its payer. Anyone can call it.
    pub fn close_attestation(ctx: Context<CloseAttestation>) -> Result<()> {
        ctx.accounts.close_attestation()
    }
}
