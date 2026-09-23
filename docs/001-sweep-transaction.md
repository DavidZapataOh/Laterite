# ADR-001: Sweep Transaction Shape

**Status:** Accepted
**Date:** 2026-09-21

## Context

The sweep pulls a subscriber's stablecoins through Subscriptions & Allowances and swaps them into SPYx through Jupiter. It is permissionless and signed by a crank, never by a wallet. Its shape decides the program's state, the crank and the transaction builders.

## Decision

- **Transaction:** a single atomic transaction, version 1 (no lookup tables), with Jupiter routes requested with `maxAccounts` = 40.
- **Plan ownership:** one program address, the vault authority (`["vault"]`), owns each plan and pulls as its owner (no pullers); a second one, the swap authority (`["swap"]`), is each plan's only destination and the only signer of the route. The plan owner's signature can pull any subscriber of the plan and update or delete the plan, so it never reaches a route: every venue of a Jupiter route receives the taker's signature. `create_plan` takes a separate payer.
- **Subscriptions binding:** the Foundation's `subscriptions` crate (`=0.5.0`) CPI builders.
- **Router binding:** one raw `invoke_signed` with caller-built data and accounts (Jupiter's `route_v2` on mainnet and the fork, the devnet CPMM's `swap_base_input` on devnet). The program checks only the router's address against its config, which `initialize` fixes, signs only as the swap authority, and enforces the outcome: every swap-authority token account the route can write, and the payment account the pull fills, ends the sweep exactly as it started (data and length), the route leaves no new account under the swap authority, and the user's asset balance rises by at least the minimum output.
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

### The sweep as built (LiteSVM 0.16, 2026-09-22)

Attestations became their own instruction and transaction, so the sweep carries no dedupe account and no attestation signature. It carries one ed25519 instruction with one signature entry per price update: the asset's (SPYX/USD or QQQX/USD), and for USDT a second, separate USDT/USD update, each verified by its own Pyth Pro `verify_message` call. USDC counts at one dollar and carries no second update. The 8 reserved accounts are Pyth Pro's program, storage and treasury, the instructions sysvar, the system program, the config, the user's settings and the event authority of the sweep's self-CPI event.

Measured through our devnet CPMM, which exercises the same instruction as mainnet with a 13-account route, against devnet's Pyth Pro, with the relayed 548-byte asset update and a 152-byte USDT update:

| Payment token | Updates     | Size    | Accounts | CU (total) | Pyth Pro        | Subscriptions | CPMM   | Event | Laterite | Fees (lamports) |
| ------------- | ----------- | ------- | -------- | ---------- | --------------- | ------------- | ------ | ----- | -------- | --------------- |
| USDC          | 548 B       | 1,794 B | 32       | 78,913     | 18,500          | 5,919         | 26,525 | 419   | 27,550   | 10,001          |
| USDT          | 548 + 152 B | 1,960 B | 32       | 101,777    | 18,557 + 18,579 | 7,419         | 26,525 | 419   | 30,278   | 15,002          |

- A USDT sweep costs 166 bytes (its update and a 14-byte signature entry), about 23,000 compute units (a second Pyth Pro call and USDT's own price) and 5,001 lamports (a second precompile signature and Pyth Pro's fee) more than a USDC sweep.
- The asset update's size is set by Kamino Scope's feed list (eight feeds today), a third party's choice; a single-feed update would be 152 bytes. Even a USDC sweep through the shortest route is past v0's 1,232 bytes without a lookup table.
- Each `verify_message` costs about 18,500 compute units under the sweep against 11,950 at the top level, because it deserializes the calling instruction from the instructions sysvar: about 210 more for every account the sweep carries. Budget about 24,000 per call for a 40-account route.
- Separating the swap authority from the plan owner costs one account: 33 bytes (its address and its index in the sweep) and, like every account the sweep carries, about 210 compute units in each Pyth Pro call.
- Checking the swap authority's token accounts before and after the route costs 950 compute units on the CPMM route, about 75 more per further writable token account in the route and about 280 per further swap-authority account.
- The config the sweep loads is 863 bytes, 402 of them the NYSE calendar and the cluster's genesis hash; the loaded-accounts data a v1 sweep must budget is dominated by the program binaries it invokes, so the crank sets that limit from simulation.
- Worst case at `maxAccounts` 40, estimated from the USDT row above and the USDT fork rows (the fork suite measures it): 59 of 64 accounts (the fork's 58, the reserve's 8 now named, plus the swap authority); 2,900–3,050 of 4,096 bytes, that is 1,960 bytes, plus about 27 more accounts than the CPMM route at 33 bytes each (32 for the address, 1 for its index in the sweep), about 890, plus Jupiter's route data in place of the CPMM's 24 bytes, 50 to 200 more; about 238,000 compute units.
- Logs: 3.1–3.7 KB through the CPMM. Classic-pool Jupiter routes for SPYx logged up to 5.8 KB on mainnet, and longer routes up to 7.2 KB, so a sweep can approach the 10,000-byte truncation limit; the event is emitted by self-CPI, which truncation cannot drop.

## Consequences

- One instruction does the whole sweep: no intermediate balance survives a transaction, so there is no second step, no invariant between steps and no partial state for the crank to reconcile. The program enforces it on every swap-authority token account the route can write (its SPYx account, the USDC account of USDT routes) and on the payment account: each ends as it started, data and length, and the route leaves no new account under the swap authority, so a route cannot keep or take a unit, approve a delegate, change an authority, reallocate or reconfigure an account's extensions. The vault authority holds no token account and never signs a route, so a route cannot pull a subscriber or change a plan.
- No address lookup table to create or maintain for the sweep. The crank builds v1 transactions with a loaded-accounts data limit set explicitly (v1 budgets zero otherwise) and a compute limit sized from the measured maximum.
- Routes are requested with `maxAccounts` = 40. Adding accounts to the sweep beyond the 8 reserved lowers that value; the CU benchmark in CI catches it.
- Transaction builders and wallets must support v1 messages. Onboarding is measured separately and may still use v0 with a lookup table.
- The swap authority is Jupiter's taker: it needs a payment-token account per token, a SPYx account and one account per intermediate mint before the first sweep; the deployment runbook creates them.
