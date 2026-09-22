use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::{errors::LateriteError, ASSET_COUNT, PAYMENT_TOKEN_COUNT};

/// Global settings at `[CONFIG_SEED]`: 463 bytes with the discriminator.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Set by `propose_admin`; `Pubkey::default()` when no handover is pending.
    pub pending_admin: Pubkey,
    /// Kill switch: when set, enrollment and sweeps stop.
    pub paused: bool,
    /// The only program the sweep may swap through.
    pub router: Pubkey,
    /// Ed25519 key whose signatures attest incoming and outgoing payments.
    pub attestor: Pubkey,
    /// Pays the fees and rent of users' onboarding; `enroll` requires it as payer.
    pub sponsor: Pubkey,
    /// Beta cap per user and week, in USD with 6 decimals.
    pub user_weekly_cap: u64,
    /// Beta cap on enrolled users; `user_count` is kept by enrollment and exit.
    pub max_users: u32,
    pub user_count: u32,
    /// SPYx first (the default), then QQQx. Set once by `initialize`.
    pub assets: [Asset; ASSET_COUNT],
    /// USDC, then USDT. Set once by `initialize`.
    pub payment_tokens: [PaymentToken; PAYMENT_TOKEN_COUNT],
    pub bump: u8,
    /// Bump of the vault authority at `[VAULT_SEED]`.
    pub vault_bump: u8,
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

/// What the admin can change after initialization.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub router: Pubkey,
    pub attestor: Pubkey,
    pub sponsor: Pubkey,
    pub user_weekly_cap: u64,
    pub max_users: u32,
}

/// Everything `initialize` sets. The tables never change afterwards, because users refer to entries by index.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ConfigParams {
    pub settings: Settings,
    pub assets: [Asset; ASSET_COUNT],
    pub payment_tokens: [PaymentToken; PAYMENT_TOKEN_COUNT],
}

impl Settings {
    pub fn validate(&self) -> Result<()> {
        require_keys_neq!(self.router, Pubkey::default(), LateriteError::InvalidRouter);
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
                mint_matches(mint, &token.mint, &token.token_program, token.decimals),
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
    /// Applies the settings; admin, pause state, tables, user count and bumps are left untouched.
    pub fn apply(&mut self, settings: &Settings) {
        self.router = settings.router;
        self.attestor = settings.attestor;
        self.sponsor = settings.sponsor;
        self.user_weekly_cap = settings.user_weekly_cap;
        self.max_users = settings.max_users;
    }
}
