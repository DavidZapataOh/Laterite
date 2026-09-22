use anchor_lang::prelude::*;

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
