# ADR-001: Sweep Transaction Shape

**Status:** Accepted
**Date:** 2026-09-21

## Context

The sweep pulls a subscriber's stablecoins through Subscriptions & Allowances and swaps them into SPYx through Jupiter. It is permissionless and signed by a crank, never by a wallet. Its shape decides the program's state, the crank and the transaction builders.

## Decision

- **Transaction:** a single atomic transaction, version 1 (no lookup tables), with Jupiter routes requested with `maxAccounts` = 40.
- **Plan ownership:** a program address owns each plan and is its only destination; it pulls as the plan owner (no pullers). `create_plan` takes a separate payer.
- **Subscriptions binding:** the Foundation's `subscriptions` crate (`=0.5.0`) CPI builders.
- **Jupiter binding:** raw `invoke_signed` with the API's `route_v2` data and accounts; the program checks the discriminator and input amount, signs only as the vault, and enforces an unchanged vault balance and a minimum output from balances.
- **Minimum output:** derived on-chain from a verified Pyth price. A caller-supplied minimum, as used while measuring, is never acceptable in a permissionless sweep: its caller could sandwich it.

## Measurements

Mainnet fork (Surfpool 1.6.0, forked from the public mainnet RPC at about slot 449,168,800, Jupiter Swap API V2 `/build`, 2026-09-21). Each row is 30 quotes (amounts of 1, 10 and 25 dollars, 10 quotes each) routed through classic pools only. Reserve included: real ed25519 instructions over 256 and 144 bytes inside the measured transaction, plus 8 accounts and 38,000 compute units added to the result.

| Input | Version | maxAccounts | Fits | Size (median / max) | Accounts (median / max) | CU (median / max) |
| ----- | ------- | ----------- | ---- | ------------------- | ----------------------- | ----------------- |
| USDC  | v0      | 20          | 0%   | 1553 / 1553         | 32 / 32                 | too large         |
| USDC  | v0      | 30          | 0%   | 1550 / 1711         | 30 / 40                 | too large         |
| USDC  | v0      | 40          | 0%   | 1550 / 1711         | 30 / 40                 | too large         |
| USDC  | v0      | 64          | 0%   | 1711 / 1868         | 40 / 47                 | too large         |
| USDC  | v1      | 20          | 100% | 1854 / 1854         | 31 / 31                 | 93,315 / 93,445   |
| USDC  | v1      | 30          | 100% | 1789 / 2133         | 29 / 39                 | 88,482 / 149,285  |
| USDC  | v1      | 40          | 100% | 1789 / 2133         | 29 / 39                 | 88,482 / 149,331  |
| USDC  | v1      | 64          | 100% | 2133 / 2380         | 39 / 46                 | 149,154 / 203,528 |
| USDT  | v0      | 20          | 0%   | no route            |                         |                   |
| USDT  | v0      | 30          | 0%   | 1648 / 1648         | 42 / 42                 | too large         |
| USDT  | v0      | 40          | 0%   | 1648 / 1926         | 42 / 51                 | too large         |
| USDT  | v0      | 64          | 0%   | 1793 / 1998         | 50 / 64                 | too large         |
| USDT  | v1      | 20          | 0%   | no route            |                         |                   |
| USDT  | v1      | 30          | 100% | 2194 / 2194         | 41 / 41                 | 144,750 / 144,876 |
| USDT  | v1      | 40          | 100% | 2194 / 2500         | 41 / 50                 | 144,750 / 191,957 |
| USDT  | v1      | 64          | 63%  | 2470 / 2951         | 49 / 63                 | 185,889 / 255,875 |

- A v0 transaction never fits: the two ed25519 instructions carry their messages inline, which takes it past 1,232 bytes even with Jupiter's lookup tables. v1 fits every quote at `maxAccounts` 30 and 40 for both inputs; 40 leaves routes more room at the same fit. Worst case at 40 with the reserve: 2,756 of 4,096 bytes, 58 of 64 accounts, about 230,000 compute units.
- USDT has no classic-pool route within 20 accounts: it needs a hop through USDC.
- Subscriptions `transfer_subscription` by CPI: 7,419 compute units.
- Vault token accounts: route_v2 needs the vault's own SPYx account (even when the output goes to the subscriber) and, for USDT, a USDC account for the intermediate hop; the product creates them once, at deployment.
- Transaction version support: v1 active on mainnet since slot 447,120,000 and on devnet since slot 492,480,000.
- SPYx extensions read on the fork: MetadataPointer, PermanentDelegate, DefaultAccountState (initialized), ScaledUiAmount, Pausable, ConfidentialTransferMint, TransferHook (no program), TokenMetadata. New accounts start initialized, so a fresh subscriber account receives SPYx without an issuer action.
- Fork reproducibility: 2 of 480 quotes (0.4%) failed on-chain inside the route (custom error 6023) because cloned pool state goes stale on a frozen fork; an earlier run showed 3 of 480 (6022). The public datasource also stalls remote fetches after long idle periods; a keyed RPC avoids it.

These numbers are the baseline. The program's CU benchmark in CI supersedes them once it exists.

## Consequences

- One instruction does the whole sweep: no intermediate vault balance survives a transaction, so there is no second step, no vault invariant between steps and no partial state for the crank to reconcile.
- No address lookup table to create or maintain for the sweep. The crank builds v1 transactions with a loaded-accounts data limit set explicitly (v1 budgets zero otherwise) and a compute limit sized from the measured maximum.
- Routes are requested with `maxAccounts` = 40. Adding accounts to the sweep beyond the 8 reserved lowers that value; the CU benchmark in CI catches it.
- Transaction builders and wallets must support v1 messages. Onboarding is measured separately and may still use v0 with a lookup table.
- The vault needs a SPYx account and one account per intermediate mint before the first sweep; the deployment runbook creates them.
