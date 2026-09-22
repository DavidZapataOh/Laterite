use anchor_lang::{derive_program_address, prelude::*};
use subscriptions::{Plan, SUBSCRIPTIONS_ID};

/// Seed of the [`Config`](crate::Config) account.
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

/// Seed of the vault authority: it owns every plan, is their only destination and signs swaps.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Entries in the asset table: SPYx (default) and QQQx.
pub const ASSET_COUNT: usize = 2;

/// Entries in the payment-token table: USDC and USDT.
pub const PAYMENT_TOKEN_COUNT: usize = 2;

/// Seed of a user's [`UserConfig`](crate::UserConfig), followed by the user's address.
#[constant]
pub const USER_CONFIG_SEED: &[u8] = b"user";

/// Weekly tiers in USD with 6 decimals: $10 and $25. A user's tier is their combined weekly cap.
pub const TIERS: [u64; 2] = [10_000_000, 25_000_000];

/// Weekly cap during a user's first week: $5.
pub const TRIAL_CAP: u64 = 5_000_000;

/// Length of the trial: one week from enrollment.
pub const TRIAL_SECONDS: i64 = 7 * 24 * 60 * 60;

/// Every plan's period: one week.
pub const PLAN_PERIOD_HOURS: u64 = 168;

/// Plan ids reserved per payment token. A tier beyond it fails the build rather than renumber another token's plans.
pub const PLAN_IDS_PER_TOKEN: usize = 2;

const _: () = assert!(TIERS.len() <= PLAN_IDS_PER_TOKEN);

/// Subscriptions `plan_id` of a payment token's tier: 1–4.
pub const fn plan_id(payment_token: usize, tier: usize) -> u64 {
    (payment_token * PLAN_IDS_PER_TOKEN + tier) as u64 + 1
}

/// The vault authority's address, derived at compile time.
pub const VAULT: Pubkey = Pubkey::new_from_array(derive_program_address(&[VAULT_SEED], &crate::ID.to_bytes()).0);

/// Each payment token's plans by tier, derived at compile time.
pub const PLANS: [[Pubkey; TIERS.len()]; PAYMENT_TOKEN_COUNT] = [[plan(0, 0), plan(0, 1)], [plan(1, 0), plan(1, 1)]];

const fn plan(payment_token: usize, tier: usize) -> Pubkey {
    let seeds: &[&[u8]] = &[Plan::PREFIX, &VAULT.to_bytes(), &plan_id(payment_token, tier).to_le_bytes()];
    Pubkey::new_from_array(derive_program_address(seeds, &SUBSCRIPTIONS_ID.to_bytes()).0)
}
