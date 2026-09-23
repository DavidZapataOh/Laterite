use anchor_lang::prelude::*;

use crate::{ConfigParams, Settings};

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
