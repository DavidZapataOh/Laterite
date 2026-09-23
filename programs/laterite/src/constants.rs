use anchor_lang::{derive_program_address, prelude::*};
use subscriptions::{EventAuthority, Plan, SUBSCRIPTIONS_ID};

/// Seed of the [`Config`](crate::Config) account.
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

/// Seed of the vault authority: it owns every plan and pulls from it as its owner.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Seed of the swap authority: every plan's only destination and the only signer of a sweep's route, so a route
/// never carries the plan owner's signature.
#[constant]
pub const SWAP_SEED: &[u8] = b"swap";

/// Entries in the asset table: SPYx (default) and QQQx.
pub const ASSET_COUNT: usize = 2;

/// Entries in the payment-token table: USDC and USDT.
pub const PAYMENT_TOKEN_COUNT: usize = 2;

/// Decimals of every payment token: amounts, caps and cushions count one dollar as 1,000,000 raw units.
pub const USD_DECIMALS: u8 = 6;

/// Seed of a user's [`UserConfig`](crate::UserConfig), followed by the user's address.
#[constant]
pub const USER_CONFIG_SEED: &[u8] = b"user";

/// Seed of an [`AttestationRecord`](crate::AttestationRecord), followed by the user's address, the two halves of the
/// transfer's transaction signature and its transfer index.
#[constant]
pub const ATTESTATION_SEED: &[u8] = b"attestation";

/// Prefix of every attested message. The attestor signs it, then the program's address, `Config.genesis_hash` and the
/// [`Attestation`](crate::Attestation)'s Borsh encoding, so a signature counts only in this deployment.
#[constant]
pub const ATTESTATION_DOMAIN: &[u8] = b"laterite:attestation:v1";

/// How long a transfer can be attested after it happened; its record can be closed afterwards.
#[constant]
pub const ATTESTATION_TTL_SECONDS: i64 = 7 * DAY_SECONDS;

/// Days a market calendar spans from the day it is loaded: four years, rounded up to whole bytes of its bitmaps.
pub const CALENDAR_DAYS: usize = 1_464;

/// How old a closure the admin loads may be, in days, so a whole published year stays loadable during that year.
pub const CALENDAR_MAX_AGE_DAYS: i64 = 366;

/// Weekly tiers in USD with 6 decimals: $10 and $25. A user's tier is their combined weekly cap.
pub const TIERS: [u64; 2] = [10_000_000, 25_000_000];

/// Seconds in a day; days are counted in UTC from 1970-01-01.
pub const DAY_SECONDS: i64 = 24 * 60 * 60;

/// A user's weeks start at `enrolled_at`, as their subscriptions' periods do.
pub const WEEK_SECONDS: i64 = 7 * DAY_SECONDS;

/// Weekly cap during a user's first week: $5.
pub const TRIAL_CAP: u64 = 5_000_000;

/// Length of the trial: the user's first week.
pub const TRIAL_SECONDS: i64 = WEEK_SECONDS;

/// Every plan's period: one week.
pub const PLAN_PERIOD_HOURS: u64 = 168;

/// Plan ids reserved per payment token. A tier beyond it fails the build rather than renumber another token's plans.
pub const PLAN_IDS_PER_TOKEN: usize = 2;

const _: () = assert!(TIERS.len() <= PLAN_IDS_PER_TOKEN);

/// Subscriptions `plan_id` of a payment token's tier: 1–4.
pub const fn plan_id(payment_token: usize, tier: usize) -> u64 {
    (payment_token * PLAN_IDS_PER_TOKEN + tier) as u64 + 1
}

const VAULT_PDA: ([u8; 32], u8) = derive_program_address(&[VAULT_SEED], &crate::ID.to_bytes());

/// The vault authority's address and bump, derived at compile time.
pub const VAULT: Pubkey = Pubkey::new_from_array(VAULT_PDA.0);
pub const VAULT_BUMP: u8 = VAULT_PDA.1;

const SWAP: ([u8; 32], u8) = derive_program_address(&[SWAP_SEED], &crate::ID.to_bytes());

/// The swap authority's address and bump, derived at compile time.
pub const SWAP_AUTHORITY: Pubkey = Pubkey::new_from_array(SWAP.0);
pub const SWAP_AUTHORITY_BUMP: u8 = SWAP.1;

/// Each payment token's plans by tier, derived at compile time.
pub const PLANS: [[Pubkey; TIERS.len()]; PAYMENT_TOKEN_COUNT] = [[plan(0, 0), plan(0, 1)], [plan(1, 0), plan(1, 1)]];

const fn plan(payment_token: usize, tier: usize) -> Pubkey {
    let seeds: &[&[u8]] = &[Plan::PREFIX, &VAULT.to_bytes(), &plan_id(payment_token, tier).to_le_bytes()];
    Pubkey::new_from_array(derive_program_address(seeds, &SUBSCRIPTIONS_ID.to_bytes()).0)
}

/// The Subscriptions program's event authority, which `transfer_subscription` requires.
pub const SUBSCRIPTIONS_EVENT_AUTHORITY: Pubkey =
    Pubkey::new_from_array(derive_program_address(&[EventAuthority::PREFIX], &SUBSCRIPTIONS_ID.to_bytes()).0);
