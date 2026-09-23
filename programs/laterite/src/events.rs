use anchor_lang::prelude::*;

use crate::{Attestation, ConfigParams, Settings};

#[event]
pub struct ConfigInitialized {
    pub params: ConfigParams,
}

#[event]
pub struct SettingsUpdated {
    pub settings: Settings,
}

#[event]
pub struct PausedSet {
    pub paused: bool,
}

#[event]
pub struct MarketCalendarSet {
    pub holidays: Vec<u16>,
    pub early_closes: Vec<u16>,
    pub valid_through: u16,
}

#[event]
pub struct AdminProposed {
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminAccepted {
    pub admin: Pubkey,
}

#[event]
pub struct PlanCreated {
    pub payment_token: u8,
    pub tier: u8,
    pub plan: Pubkey,
}

#[event]
pub struct Enrolled {
    pub user: Pubkey,
    pub tier: u8,
    pub payment_tokens: u8,
    pub asset: u8,
}

#[event]
pub struct Attested {
    pub attestation: Attestation,
    /// What the user's rule adds to `pending`.
    pub invested: u64,
    pub pending: u64,
}

#[event]
pub struct Swept {
    pub user: Pubkey,
    pub payment_token: u8,
    pub asset: u8,
    /// Pulled for the engine and for pending amounts, in the payment token's raw units.
    pub engine: u64,
    pub pending: u64,
    /// The asset's verified price, `asset_price × 10^asset_exponent` dollars per 10^decimals raw units: the
    /// display multiplier is included, so a UI token costs this price over the multiplier.
    pub asset_price: u64,
    pub asset_exponent: i16,
    /// Raw asset units the user received, and the minimum the prices allowed.
    pub received: u64,
    pub min_out: u64,
}
