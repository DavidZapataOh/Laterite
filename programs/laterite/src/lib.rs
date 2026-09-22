//! Laterite: a capped, revocable autopilot from stablecoins into tokenized stocks.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use constants::*;
pub use errors::LateriteError;
pub use instructions::*;
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

    /// First step of an admin handover; `Pubkey::default()` cancels a pending one.
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.propose_admin(new_admin)
    }

    /// Second step: the proposed admin signs to take over.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        ctx.accounts.accept_admin()
    }
}
