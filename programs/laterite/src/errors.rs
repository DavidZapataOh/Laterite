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
}
