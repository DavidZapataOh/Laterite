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
pub mod subscription;

pub use amount::*;
pub use constants::*;
pub use errors::LateriteError;
pub use instructions::*;
pub use market::*;
pub use price::*;
pub use state::*;

declare_id!("LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf");

declare_program!(pyth_lazer_solana_contract);

#[program]
pub mod laterite {
    use super::*;

    /// Creates the config; only the program's upgrade authority can call it, once. Remaining accounts: the
    /// tables' mint accounts in order, the assets then the payment tokens.
    pub fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
        ctx.accounts.initialize(params, &ctx.bumps, ctx.remaining_accounts)
    }

    /// Replaces the settings: attestor, sponsor and beta caps. The router and the tables are fixed at `initialize`.
    pub fn update_config(ctx: Context<AdminOnly>, settings: Settings) -> Result<()> {
        ctx.accounts.update_config(settings)
    }

    /// Kill switch: stops enrollment, reactivation and sweeps while set; the users' own controls keep working.
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

    /// Publishes a payment token's weekly tier as a Subscriptions plan owned by the vault authority, paying only into
    /// the swap authority's accounts; the admin pays its rent, which is not refundable.
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

    /// Invests what is due for one user and payment token, once per UTC day. Verifies the Pyth Pro updates by CPI:
    /// `asset_message` for the asset and, for a payment token with a price feed, `payment_message`, signature entries
    /// 0 and 1 of the ed25519 instruction at `ed25519_index`. Pulls through the user's subscription, swaps through
    /// the configured router with the caller's `route` data and the remaining accounts, and checks that the user
    /// received at least the minimum the prices allow. Anyone can call it.
    pub fn sweep<'info>(
        ctx: Context<'info, Sweep<'info>>,
        asset_message: Vec<u8>,
        payment_message: Vec<u8>,
        ed25519_index: u16,
        payment_token: u8,
        route: Vec<u8>,
    ) -> Result<()> {
        let event = ctx.accounts.sweep(
            asset_message,
            payment_message,
            ed25519_index,
            payment_token,
            route,
            ctx.remaining_accounts,
        )?;
        emit_cpi!(event);
        Ok(())
    }

    /// Replaces the user's asset, engine, rules, cushions and goal; the tier and the payment tokens change through
    /// their own instructions. A rule turned on or a larger multiplier credits only transfers from then on.
    pub fn update_settings(ctx: Context<UserOnly>, params: EnrollParams) -> Result<()> {
        ctx.accounts.update_settings(params)
    }

    /// Pauses an active user or resumes a paused one. Nothing is pulled or credited while paused, and a resumed user
    /// is credited only for transfers from the resume on.
    pub fn set_user_paused(ctx: Context<UserOnly>, paused: bool) -> Result<()> {
        ctx.accounts.set_user_paused(paused)
    }

    /// Lowers the user's pending amount to any smaller value, 0 included; it can never raise it.
    pub fn lower_pending(ctx: Context<UserOnly>, pending: u64) -> Result<()> {
        ctx.accounts.lower_pending(pending)
    }

    /// Moves the user to another weekly tier: ends each current subscription at once, the vault signing as the plans'
    /// owner, and requires a live subscription to the new tier's plan for each enabled payment token. The week's
    /// spending carries over, so a change never grants a second cap in one week.
    pub fn change_tier<'info>(ctx: Context<'info, PlanChange<'info>>, tier: u8) -> Result<()> {
        ctx.accounts.change_tier(tier, ctx.remaining_accounts)
    }

    /// Changes the enabled payment tokens: ends a dropped token's subscription at once, the vault signing as the
    /// plans' owner, and requires a live subscription to the tier's plan for an added one. An added token credits
    /// only transfers from then on; the day's sweeps stay spent.
    pub fn change_payment_tokens<'info>(ctx: Context<'info, PlanChange<'info>>, payment_tokens: u8) -> Result<()> {
        ctx.accounts.change_payment_tokens(payment_tokens, ctx.remaining_accounts)
    }

    /// Leaves Laterite: ends each subscription at once, the vault signing as the plans' owner, frees the beta seat,
    /// discards the pending amount and clears the settings. The account and its counters stay, so a return through
    /// `reactivate` grants no new trial, week or sweep day.
    pub fn exit<'info>(ctx: Context<'info, Exit<'info>>) -> Result<()> {
        ctx.accounts.exit(ctx.remaining_accounts)
    }

    /// Returns a user who exited, with new settings, under enrollment's checks; the configured sponsor signs. Credits
    /// only transfers from the reactivation on. Remaining accounts: the user's subscription to the chosen tier for each
    /// enabled payment token, in token order.
    pub fn reactivate(ctx: Context<Reactivate>, params: EnrollParams) -> Result<()> {
        ctx.accounts.reactivate(params, ctx.remaining_accounts)
    }
}
