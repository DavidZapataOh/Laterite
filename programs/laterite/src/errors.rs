use anchor_lang::prelude::*;

#[error_code]
pub enum LateriteError {
    #[msg("Only the program's upgrade authority can initialize the config")]
    NotUpgradeAuthority,
    #[msg("Only the admin can do this")]
    Unauthorized,
    #[msg("The signer is not the pending admin")]
    NotPendingAdmin,
    #[msg("The router is not set, or is not the configured one")]
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
    #[msg("Market closures must be strictly ascending")]
    CalendarNotAscending,
    #[msg("A market closure falls on a weekend, on both lists or outside the calendar's window")]
    ImplausibleMarketDay,
    #[msg("The price update is malformed, or given for a token counted at one dollar")]
    InvalidPriceUpdate,
    #[msg("The price update has no usable price for the feed")]
    PriceUnavailable,
    #[msg("The price is too old")]
    StalePrice,
    #[msg("The price's confidence interval is too wide")]
    PriceUncertain,
    #[msg("The amount buys less than one raw unit of the asset")]
    AmountTooSmall,
    #[msg("The cluster's genesis hash is not set")]
    InvalidGenesisHash,
    #[msg("The previous instruction is not the attestor's signature over this attestation for this deployment")]
    InvalidAttestationSignature,
    #[msg("The attestation has no amount or its transfer is outside the user's window")]
    InvalidAttestation,
    #[msg("The user is paused or has exited")]
    UserNotActive,
    #[msg("The attested transfer is too old")]
    AttestationExpired,
    #[msg("The user's rules invest nothing for this transfer")]
    NothingToInvest,
    #[msg("The attestation record has not expired yet")]
    AttestationNotExpired,
    #[msg("This payment token was already swept today")]
    AlreadySwept,
    #[msg("Nothing is due for this payment token")]
    NothingToSweep,
    #[msg("A token account is not the expected one")]
    InvalidTokenAccount,
    #[msg("A swap-authority token account did not end the sweep as it started")]
    SwapAccountChanged,
    #[msg("The swap returned less than the minimum output")]
    SlippageExceeded,
    #[msg("The tier and the payment tokens change through their own instructions")]
    PlanChangeRequired,
    #[msg("Pending amounts can only be lowered")]
    PendingIncrease,
    #[msg("The user is not paused")]
    UserNotPaused,
    #[msg("The user has not exited")]
    UserNotExited,
}
