use anchor_lang::prelude::*;

#[error_code]
pub enum LateriteError {
    #[msg("Only the program's upgrade authority can initialize the config")]
    NotUpgradeAuthority,
    #[msg("Only the admin can do this")]
    Unauthorized,
    #[msg("The signer is not the pending admin")]
    NotPendingAdmin,
    #[msg("The router address is not set")]
    InvalidRouter,
    #[msg("The attestor key is not set")]
    InvalidAttestor,
    #[msg("Caps must be greater than zero")]
    InvalidCap,
    #[msg("An asset entry does not match its mint account or has no price feed")]
    InvalidAsset,
    #[msg("A payment-token entry does not match its mint account")]
    InvalidPaymentToken,
    #[msg("The sponsor key is not set")]
    InvalidSponsor,
    #[msg("The program is paused")]
    ProgramPaused,
    #[msg("The beta is full")]
    BetaFull,
    #[msg("Not one of the configured payment tokens")]
    UnknownPaymentToken,
    #[msg("Not one of the weekly tiers")]
    InvalidTier,
    #[msg("The tier is above the beta's weekly cap")]
    CapAboveBetaLimit,
    #[msg("Not one of the configured assets")]
    UnknownAsset,
    #[msg("At least one configured payment token must be enabled")]
    NoPaymentToken,
    #[msg("The rules are out of range or invest nothing")]
    InvalidRules,
    #[msg("A subscription to the chosen tier is missing for an enabled payment token")]
    SubscriptionMismatch,
    #[msg("Only the configured sponsor can pay for enrollment")]
    NotSponsor,
}
