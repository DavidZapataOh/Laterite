use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::{errors::LateriteError, ASSET_COUNT, CALENDAR_DAYS, PAYMENT_TOKEN_COUNT, TIERS, USD_DECIMALS};

/// Global settings at `[CONFIG_SEED]` ([`CONFIG`](crate::CONFIG)): 863 bytes with the discriminator.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Set by `propose_admin`; `Pubkey::default()` when no handover is pending.
    pub pending_admin: Pubkey,
    /// Kill switch: when set, enrollment, reactivation and sweeps stop; the users' own controls keep working.
    pub paused: bool,
    /// The only program the sweep may swap through. Set once by `initialize`.
    pub router: Pubkey,
    /// Ed25519 key whose signatures attest incoming and outgoing payments.
    pub attestor: Pubkey,
    /// Pays the fees and rent of users' onboarding; `enroll` requires it as payer.
    pub sponsor: Pubkey,
    /// Beta cap per user and week, in USD with 6 decimals.
    pub user_weekly_cap: u64,
    /// Beta cap on enrolled users; `user_count` is kept by enrollment, reactivation and exit.
    pub max_users: u32,
    pub user_count: u32,
    /// SPYx first (the default), then QQQx. Set once by `initialize`.
    pub assets: [Asset; ASSET_COUNT],
    /// USDC, then USDT. Set once by `initialize`.
    pub payment_tokens: [PaymentToken; PAYMENT_TOKEN_COUNT],
    /// NYSE closures, loaded by the admin as the exchange publishes them; empty until then, so the market counts
    /// as closed.
    pub market_calendar: MarketCalendar,
    /// Genesis hash of the cluster this deployment runs on. Set once by `initialize`; attestations sign it, so they
    /// count only on this cluster.
    pub genesis_hash: [u8; 32],
}

/// A tokenized stock the sweep can buy.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Asset {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    /// Pyth Pro feed id of the asset's USD price, quoted per raw token unit.
    pub pyth_feed_id: u32,
}

/// A stablecoin users are pulled in.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PaymentToken {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    /// Pyth Pro feed id of the token's USD price; 0 when it is priced at one dollar.
    pub usd_feed_id: u32,
}

/// The NYSE closures the weekly engine respects, one bit per day: bit `i` of a bitmap (byte `i / 8`, bit `i % 8`)
/// stands for day `first_day + i`, counted from 1970-01-01.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarketCalendar {
    /// The day the calendar was loaded.
    pub first_day: u16,
    /// The last day the calendar covers; outside `first_day..=valid_through` the market counts as closed.
    pub valid_through: u16,
    /// Full-day closures.
    pub holidays: [u8; CALENDAR_DAYS / 8],
    /// Days the market closes at 13:00 New York time.
    pub early_closes: [u8; CALENDAR_DAYS / 8],
}

impl Default for MarketCalendar {
    fn default() -> Self {
        Self { first_day: 0, valid_through: 0, holidays: [0; CALENDAR_DAYS / 8], early_closes: [0; CALENDAR_DAYS / 8] }
    }
}

/// What the admin can change after initialization.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub attestor: Pubkey,
    pub sponsor: Pubkey,
    pub user_weekly_cap: u64,
    pub max_users: u32,
}

/// Everything `initialize` sets. The tables and the router never change afterwards: users refer to table entries by
/// index, and the vault signs the router's instruction.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ConfigParams {
    pub settings: Settings,
    pub assets: [Asset; ASSET_COUNT],
    pub payment_tokens: [PaymentToken; PAYMENT_TOKEN_COUNT],
    /// Genesis hash of the cluster being deployed to, as `getGenesisHash` returns it: the program cannot read it, so
    /// the deployment supplies it and checks it.
    pub genesis_hash: [u8; 32],
    /// The only program a sweep may swap through.
    pub router: Pubkey,
}

impl Settings {
    pub fn validate(&self) -> Result<()> {
        require_keys_neq!(self.attestor, Pubkey::default(), LateriteError::InvalidAttestor);
        require_keys_neq!(self.sponsor, Pubkey::default(), LateriteError::InvalidSponsor);
        require!(self.user_weekly_cap > 0 && self.max_users > 0, LateriteError::InvalidCap);
        Ok(())
    }
}

impl ConfigParams {
    /// `mints` are the tables' mint accounts in order: the assets, then the payment tokens.
    pub fn validate(&self, mints: &[AccountInfo]) -> Result<()> {
        self.settings.validate()?;
        require_keys_neq!(self.router, Pubkey::default(), LateriteError::InvalidRouter);
        require!(self.genesis_hash != [0; 32], LateriteError::InvalidGenesisHash);
        require_gte!(
            mints.len(),
            ASSET_COUNT + PAYMENT_TOKEN_COUNT,
            anchor_lang::error::ErrorCode::AccountNotEnoughKeys
        );
        for (asset, mint) in self.assets.iter().zip(mints) {
            require!(
                asset.pyth_feed_id != 0 && mint_matches(mint, &asset.mint, &asset.token_program, asset.decimals),
                LateriteError::InvalidAsset
            );
        }
        for (token, mint) in self.payment_tokens.iter().zip(&mints[ASSET_COUNT..]) {
            require!(
                token.decimals == USD_DECIMALS && mint_matches(mint, &token.mint, &token.token_program, token.decimals),
                LateriteError::InvalidPaymentToken
            );
        }
        Ok(())
    }
}

/// The account is the entry's mint, owned by the entry's token program, with the entry's decimals.
fn mint_matches(account: &AccountInfo, mint: &Pubkey, token_program: &Pubkey, decimals: u8) -> bool {
    let is_token_program = *token_program == anchor_spl::token::ID || *token_program == anchor_spl::token_2022::ID;
    if account.key != mint || account.owner != token_program || !is_token_program {
        return false;
    }
    let Ok(data) = account.try_borrow_data() else {
        return false;
    };
    Mint::try_deserialize(&mut &data[..]).is_ok_and(|parsed| parsed.decimals == decimals)
}

impl Config {
    /// Applies the settings; admin, pause state, router, tables, calendar, genesis hash and user count are left
    /// untouched.
    pub fn apply(&mut self, settings: &Settings) {
        self.attestor = settings.attestor;
        self.sponsor = settings.sponsor;
        self.user_weekly_cap = settings.user_weekly_cap;
        self.max_users = settings.max_users;
    }
}

/// A user's signed settings and sweep state at `[USER_CONFIG_SEED, user]`: 164 bytes with the discriminator. It is
/// never closed, so its counters outlive an exit.
#[account]
#[derive(InitSpace, Debug)]
pub struct UserConfig {
    pub user: Pubkey,
    /// Index into `TIERS`: the weekly cap across both payment tokens.
    pub tier: u8,
    /// Bit `i` set when `Config.payment_tokens[i]` is enabled.
    pub payment_tokens: u8,
    /// Index into `Config.assets`.
    pub asset: u8,
    pub engine: Engine,
    /// What the engine invests each day or week, in USD with 6 decimals; 0 turns it off.
    pub engine_amount: u64,
    /// Invest a share of each incoming payment.
    pub income_rule: bool,
    /// Change per outgoing payment: 0 (off) to 3.
    pub change_multiplier: u8,
    /// Balance left untouched per payment token, in that token's raw units (6 decimals).
    pub cushions: [u64; PAYMENT_TOKEN_COUNT],
    /// Unix time of enrollment; the trial week starts here.
    pub enrolled_at: i64,
    /// Savings goal in USD with 6 decimals.
    pub goal_amount: u64,
    /// UTF-8, zero-padded.
    pub goal_label: [u8; 32],
    pub bump: u8,
    /// The week `week_spent` counts, from enrollment (see `week_at`).
    pub week: u32,
    /// Pulled in `week` across both payment tokens.
    pub week_spent: u64,
    /// When the engine last bought; before `enrolled_at` when it never has.
    pub engine_ran_at: i64,
    /// Variable amounts attested but not yet pulled; carried over until the caps let them through.
    pub pending: u64,
    /// Only an active user is pulled from or credited with attested transfers.
    pub status: UserStatus,
    /// Block time of the earliest transfer that can be attested: enrollment, raised to the clock by each return to
    /// `Active` (resume, reactivation) and each enabling of a payment token or rule that was off. Never lowered.
    pub attestable_from: i64,
    /// Per payment token, the UTC day (days since 1970-01-01) of its last sweep; 0 before the first.
    pub last_sweep_day: [u32; PAYMENT_TOKEN_COUNT],
}

/// Where a user stands. The account outlives an exit, so a returning user keeps their counters.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserStatus {
    Active,
    /// Paused by the user: nothing is pulled or credited until they resume.
    Paused,
    /// The user left; they can reactivate the same account.
    Exited,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Engine {
    #[default]
    Daily,
    Weekly,
}

/// Which rule an attested transfer feeds.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    /// A payment the user received: the income rule.
    Income,
    /// A payment the user made: change per payment.
    Payment,
}

/// A transfer the attestor observed, in the payment token's raw units.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Debug, PartialEq, Eq)]
pub struct Attestation {
    pub kind: EventKind,
    pub user: Pubkey,
    /// Index into `Config.payment_tokens`.
    pub payment_token: u8,
    pub amount: u64,
    /// Block time of the transfer.
    pub event_time: i64,
    /// The transfer's transaction signature.
    pub signature: [u8; 64],
    /// Position of the transfer, from 0 in instruction order (each outer instruction followed by its inner ones),
    /// among the transaction's transfers of either configured payment token to or from the user.
    pub transfer_index: u16,
}

/// Marks an attested transfer as counted until it expires.
#[account]
#[derive(InitSpace)]
pub struct AttestationRecord {
    /// Paid the rent and gets it back when the record is closed.
    pub payer: Pubkey,
    /// After this, the transfer can no longer be attested and the record can be closed.
    pub expires_at: i64,
}

/// What a user chooses when enrolling; the default is the cleared settings of a user who exited.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct EnrollParams {
    pub tier: u8,
    pub payment_tokens: u8,
    pub asset: u8,
    pub engine: Engine,
    pub engine_amount: u64,
    pub income_rule: bool,
    pub change_multiplier: u8,
    pub cushions: [u64; PAYMENT_TOKEN_COUNT],
    pub goal_amount: u64,
    pub goal_label: [u8; 32],
}

impl EnrollParams {
    pub fn validate(&self, config: &Config) -> Result<()> {
        let cap = *TIERS.get(self.tier as usize).ok_or(LateriteError::InvalidTier)?;
        require_gte!(config.user_weekly_cap, cap, LateriteError::CapAboveBetaLimit);
        self.validate_rules()
    }

    /// Everything but the beta cap, which binds only when a tier is chosen: the tier, asset, tokens and rules.
    pub fn validate_rules(&self) -> Result<()> {
        let cap = *TIERS.get(self.tier as usize).ok_or(LateriteError::InvalidTier)?;
        require!((self.asset as usize) < ASSET_COUNT, LateriteError::UnknownAsset);
        require!(self.payment_tokens != 0, LateriteError::NoPaymentToken);
        require!(self.payment_tokens >> PAYMENT_TOKEN_COUNT == 0, LateriteError::UnknownPaymentToken);
        let invests = self.engine_amount > 0 || self.income_rule || self.change_multiplier > 0;
        require!(invests && self.change_multiplier <= 3 && self.engine_amount <= cap, LateriteError::InvalidRules);
        Ok(())
    }
}

impl UserConfig {
    /// Writes the settings the user chose, field by field; the counters are left as they are.
    pub fn set_settings(&mut self, params: &EnrollParams) {
        self.tier = params.tier;
        self.payment_tokens = params.payment_tokens;
        self.asset = params.asset;
        self.engine = params.engine;
        self.engine_amount = params.engine_amount;
        self.income_rule = params.income_rule;
        self.change_multiplier = params.change_multiplier;
        self.cushions = params.cushions;
        self.goal_amount = params.goal_amount;
        self.goal_label = params.goal_label;
    }

    /// Credits only transfers from `now` on; `attestable_from` is never lowered.
    pub fn raise_attestable_from(&mut self, now: i64) {
        self.attestable_from = self.attestable_from.max(now);
    }
}
