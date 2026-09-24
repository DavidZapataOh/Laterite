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

Measured through our devnet CPMM (sizes as the wire carries them: a version 1 transaction is its message, then its signatures with no length prefix), which exercises the same instruction as mainnet with a 13-account route, against devnet's Pyth Pro, with the relayed 548-byte asset update and a 152-byte USDT update:

| Payment token | Updates     | Size    | Accounts | CU (total) | Pyth Pro        | Subscriptions | CPMM   | Event | Laterite | Fees (lamports) |
| ------------- | ----------- | ------- | -------- | ---------- | --------------- | ------------- | ------ | ----- | -------- | --------------- |
| USDC          | 548 B       | 1,793 B | 32       | 78,918     | 18,500          | 5,919         | 26,525 | 419   | 27,555   | 10,001          |
| USDT          | 548 + 152 B | 1,959 B | 32       | 101,787    | 18,557 + 18,579 | 7,419         | 26,525 | 419   | 30,288   | 15,002          |

- A USDT sweep costs 166 bytes (its update and a 14-byte signature entry), about 23,000 compute units (a second Pyth Pro call and USDT's own price) and 5,001 lamports (a second precompile signature and Pyth Pro's fee) more than a USDC sweep.
- The asset update's size is set by Kamino Scope's feed list (eight feeds today), a third party's choice; a single-feed update would be 152 bytes. Even a USDC sweep through the shortest route is past v0's 1,232 bytes without a lookup table.
- Each `verify_message` costs about 18,500 compute units under the sweep against 11,950 at the top level, because it deserializes the calling instruction from the instructions sysvar: about 210 more for every account the sweep carries. Budget about 24,000 per call for a 40-account route.
- Separating the swap authority from the plan owner costs one account: 33 bytes (its address and its index in the sweep) and, like every account the sweep carries, about 210 compute units in each Pyth Pro call.
- Checking the swap authority's token accounts before and after the route costs 950 compute units on the CPMM route, about 75 more per further writable token account in the route and about 280 per further swap-authority account.
- The config the sweep loads is 863 bytes, 402 of them the NYSE calendar and the cluster's genesis hash; the loaded-accounts data a v1 sweep must budget is dominated by the program binaries it invokes, so the crank sets that limit from simulation.
- The worst case at `maxAccounts` 40 was estimated here at 59 of 64 accounts, 2,900–3,050 of 4,096 bytes and about 238,000 compute units; the mainnet fork measured it (below).
- Logs: 3.1–3.7 KB through the CPMM. Classic-pool Jupiter routes for SPYx logged up to 5.8 KB on mainnet, and longer routes up to 7.2 KB, so a sweep can approach the 10,000-byte truncation limit; the event is emitted by self-CPI, which truncation cannot drop.

### The sweep on real routes (mainnet fork, 2026-09-24)

The deployed program (the verifiable build, sha256 `6a14024b…`) on a Surfpool 1.6.0 fork of mainnet, configured as a mainnet deployment would be (Jupiter as router, the mainnet mints and Pyth Pro feeds), against mainnet's own Subscriptions, Pyth Pro (storage and treasury) and pools, with the latest Kamino-relayed update (548 bytes) and, for USDT, a token-fetched USDT/USD update (152 bytes). Routes come from `buildJupiterSweepRoute` (Swap API v2 `/build`, `maxAccounts` 40); before each sweep the fork reads the route's venue accounts from mainnet again, so its pools match the quote. Sizes are the wire sizes of the transactions as sent, with their compute-unit and loaded-account limits.

Landed sweeps of a trial week's $5, through classic pools (29 runs; routes change through the day):

| Sweep        | Route                            | Size          | Accounts | CU (total)      | Pyth Pro per call    | Laterite      | Logs       | Fees (lamports) |
| ------------ | -------------------------------- | ------------- | -------- | --------------- | -------------------- | ------------- | ---------- | --------------- |
| USDC to SPYx | Whirlpool, one to three pools    | 1,983–2,638 B | 37–56    | 119,673–253,958 | 21,231–28,616        | 32,669–50,047 | 3.8–5.6 KB | 10,001          |
| USDT to SPYx | through USDC, two or three pools | 2,455–2,860 B | 46–58    | 182,933–266,382 | 23,820–27,640, twice | 41,764–51,898 | 5.1–6.2 KB | 15,002          |
| USDC to QQQx | one to three classic pools       | 2,048–2,661 B | 39–57    | 123,136–246,432 | 21,864–27,772        | 34,417–49,235 | 3.9–5.6 KB | 10,001          |

Every route the builder accepted, simulated for both payment tokens and both assets through classic pools and without restriction, at $5 and, measured through an enrollment moved back past the trial week by a fork state override (the fork's clock cannot go back to enroll a user in the past, and price updates are fresh only now), at $10 and $25 (878 routes over 29 runs, 677 of them executed):

- **Size and accounts:** executed routes at most 2,899 of 4,096 bytes and 60 of 64 accounts (the route's 16 to 42 distinct accounts, its data 39 to 122 bytes); the estimate of 59 accounts and 2,900–3,050 bytes holds for them. Routes the fork could not execute reached 3,092 bytes and 63 accounts: legs through a venue that takes its payer as a signer (HumidiFi), which fail anyway (below).
- **Compute units:** at most 407,143 (a USDT sweep into QQQx through market makers; 280,331 through classic pools), well above the 238,000 estimated. The crank sets its limit from simulation with a 10% margin, and refuses to send above 490,000, about 20% above the worst measured.
- **Pyth Pro's `verify_message` under the sweep:** 20,809 CU at 34 accounts to 28,695 on executed routes (30,172 at 63 accounts on a route that failed), about 20,000 plus 314 per account the sweep carries above 32, so a budget of 30,000 per call at the ceiling (a USDT sweep runs it twice), not 24,000.
- **Laterite's own units** (the sweep without its CPIs): up to 55,090. Regressed over the executed routes on the number of route accounts and of swap-authority token accounts the route writes: 857 ± 22 CU per route account for USDC sweeps and 750 ± 58 for USDT ones (1 standard deviation), the invoke passing every account through; the swap-authority term (−259 ± 236 and 835 ± 550 over two to four accounts) is within the noise, consistent with the about 280 per account the program's own benchmark measures for the byte-for-byte check.
- **Loaded account data** (SIMD-0186's count: each account's data and 64 bytes, and each upgradeable program's data): 4.7 to 18.0 MB, within the 64 MiB a version 1 transaction may declare; every landed sweep declared at least that count.
- **Logs:** at most 6.9 KB of the 10,000-byte truncation limit.
- **Swap-authority accounts:** every sweep left each swap-authority token account byte-identical and created none; no real route tripped `SwapAccountChanged`, the USDC hop account of USDT routes included.
- **Fill:** a landed sweep received its quote to within 1 basis point, about 1% more than `min_out`. With the venues read from mainnet again before each sweep, every classic-pool route executed; unrestricted routes through market makers still fail on the fork one time in three (their quotes rely on accounts their operators update every few slots), so the suite lands its sweeps through classic pools.

Routes also taught what the swap authority must hold and what the builder must refuse:

- **Intermediate accounts:** of 36 unrestricted quotes (2026-09-24), 16 were direct, 4 went through USDC, 11 through USDC and wrapped SOL and 5 through a third-party stablecoin; classic-pool routes also hop through wrapped SOL, into QQQx through SPYx, and at times through another token (a Whirlpool split through `AvZZF1Ya…`). The deployment creates the swap authority's accounts in USDC, USDT, SPYx, QQQx and wrapped SOL; a route through any other intermediate names a swap-authority account that does not exist, which the builder reports (`SwapAuthorityAccountsRequiredError`) so that the crank creates it (an idempotent associated-account creation in its own transaction, the token program checked against the mint's owner, once per mint, bounded per day) and builds again. The program still refuses an account created during the route.
- **Venues' own accounts** may be named before they exist (a Whirlpool tick array no swap has reached), so the builder requires only the swap authority's accounts to exist, derived from the route plan's mints.
- **Jupiter's setup** reads mainnet: it creates the taker's accounts that mainnet lacks, which a cluster may already hold, so the builder drops it once the accounts exist and refuses any other setup.
- **The payer:** some venues (HumidiFi, SolFi) take the route's payer as a signer. Named the crank, they fail with a privilege escalation, since the program never passes the crank's signature to a route; the builder therefore leaves Jupiter's payer unset, so Jupiter names the taker, the swap authority, which the program signs for. SolFi legs then execute; HumidiFi's makes its payer pay and fails (the swap authority holds no SOL). The builder still refuses a route that names the crank, as a defense in depth, and takes `excludeDexes` for a crank's retry without a failing venue.
- **`route_v2`'s data:** the slippage, platform fee and positive-slippage fee sit at offsets 24, 26 and 28, confirmed on real routes; a platform fee shows only there, not in the response's `platformFee`.
- **A manipulated pool:** after a whale's trades ($10,000 to $30,000) through the route's main Whirlpool pool on the fork, a route quoted before them, with Jupiter's own bound at 50%, is refused by the program's Pyth-derived minimum (`SlippageExceeded`); sent anyway, the sweep fails on the fork's record without spending the user's day.

## Consequences

- One instruction does the whole sweep: no intermediate balance survives a transaction, so there is no second step, no invariant between steps and no partial state for the crank to reconcile. The program enforces it on every swap-authority token account the route can write (its SPYx account, the USDC account of USDT routes) and on the payment account: each ends as it started, data and length, and the route leaves no new account under the swap authority, so a route cannot keep or take a unit, approve a delegate, change an authority, reallocate or reconfigure an account's extensions. The vault authority holds no token account and never signs a route, so a route cannot pull a subscriber or change a plan.
- No address lookup table to create or maintain for the sweep. The crank builds v1 transactions with a loaded-accounts data limit set explicitly (v1 budgets zero otherwise) and a compute limit from simulation with a 10% margin, never above 490,000 (about 20% above the measured maximum, 407,143).
- Routes are requested with `maxAccounts` = 40. Adding accounts to the sweep beyond the 8 reserved lowers that value; the CU benchmark in CI catches it.
- Transaction builders and wallets must support v1 messages. Onboarding is measured separately and may still use v0 with a lookup table.
- The swap authority is Jupiter's taker: it needs a payment-token account per token, an account per asset and a wrapped SOL account before the first sweep; the deployment runbook creates them (`JUPITER_ROUTE_MINTS`). The crank creates the account of any other intermediate a route needs, before the sweep, once per mint.
