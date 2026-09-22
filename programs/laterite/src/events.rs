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
pub struct AdminProposed {
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminAccepted {
    pub admin: Pubkey,
}
