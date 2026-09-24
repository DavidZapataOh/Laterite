# Laterite

Get paid. Lay a brick. A non-custodial autopilot on Solana that turns a capped slice of every payday into tokenized S&P 500, straight from your own wallet.

## Program ID

```
LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf
```

## Project Structure

```
apps/landing/        Marketing site (Next.js)
clients/typescript/  Generated TypeScript client (Codama)
docs/                Architecture decision records and the threat model
fuzz/laterite/       Invariant fuzz harness (Crucible, `anchor fuzz`)
idl/                 Program IDL
packages/db/         Postgres schema and migrations (Drizzle), shared by the services and the app
packages/deployment/ Deployment runbooks, their checks and the devnet smoke
packages/devnet/     Devnet stand-in assets, pools and re-peg
programs/laterite/   On-chain program (Anchor)
services/operator/   The always-on service on Railway: history indexer and operations alarms
tests/fork/          Mainnet-fork tests (Surfpool)
```

## Prerequisites

1. Rust (rustup); the toolchain in `rust-toolchain.toml` installs itself.
2. Solana CLI 4.3.0: `sh -c "$(curl -sSfL https://release.anza.xyz/v4.3.0/install)"`
3. Anchor 1.2.0: `cargo install --git https://github.com/otter-sec/anchor avm --locked --force && avm install 1.2.0 && avm use 1.2.0`
4. Docker and solana-verify 0.5.2: `cargo install solana-verify --version 0.5.2 --locked`. The program is always built in the verifiable-build image for Solana 4.3.0 (pinned by digest), so a local build, CI and the deployed program are byte-identical, and so are their compute units. On Apple Silicon, enable Docker's Rosetta emulation for amd64 images.
5. Node 24.14.0 (`.nvmrc`) and pnpm (the version in `package.json` is fetched automatically).
6. just: `brew install just`
7. Surfpool 1.6.0 (fork tests): `curl -sL https://run.surfpool.run/ | VERSION=v1.6.0 bash`, and a mainnet RPC URL in `.env` (see `.env.example`).
8. Services: Docker, for a disposable Postgres (`just db-up`) and the service's image.
9. Devnet assets: nothing more. `just build-cpmm` builds the DEX in the verifiable-build image of the Solana version its source pins (3.1.10), and the Solana CLI's `solana-test-validator` runs the local devnet.

## Quick Start

```bash
just setup
just build
just test
just check
```

Run `just` to list every recipe.

## Fork Testing

`just test-fork` boots a Surfpool mainnet fork, installs the program at its declared address and runs `tests/fork` against mainnet's own Subscriptions, Pyth Pro, Jupiter and xStocks. It needs network access and is not part of `just test`; the Fork workflow runs it on changes to the program, the clients and the suite, and every weekday. The suite:

- deploys Laterite as a cluster's runbook does (`ensureDeployment` with `mainnetConfigParams`: Jupiter as router, the mainnet mints and Pyth Pro feeds, the genesis hash the fork reports, which is mainnet's) with keys generated for the run, so only its own attestor key separates the fork's attestations from mainnet's;
- enrolls wallets with the sponsored onboarding transaction and sweeps USDC and USDT into SPYx and QQQx through real Jupiter routes, with the latest Kamino-relayed SPYX/USD or QQQX/USD update and, for USDT, a USDT/USD update fetched with `PYTH_PRO_ACCESS_TOKEN`, checking every swap-authority token account before and after (as the crank does, it first creates the swap authority's account in an intermediate mint a route needs and the deployment did not create, after checking the mint's token program; the QQQx sweep removes the swap authority's QQQx account first to exercise it);
- refuses a sweep through a pool a whale has moved (and sends it once, so the reverted transaction is on the fork's record), lands an attestation for the fork's genesis hash and refuses one signed for devnet's, and measures every route the builder accepts against the version 1 limits (4,096 bytes, 64 accounts, 10,000 log bytes).

Routes go through classic pools (Raydium CLMM, Whirlpool) on the fork, because market makers' quotes depend on accounts their operators update every few slots, which go stale once cloned; the measurements also sample unrestricted routes. Before each sweep the fork reads the route's venue accounts from mainnet again (`surfnet_resetAccount`), so its pools match the quote Jupiter made from mainnet. Surfpool reads mainnet through a local relay (`tests/fork/scripts/datasource-relay.ts`, test infrastructure only) that keeps Surfpool's connections open and retries rate-limited requests, since Surfpool otherwise reuses a connection the upstream dropped while idle and waits 30 s on it; it passes on reads only, refusing any transaction or airdrop request, so nothing the fork does reaches mainnet. The public endpoint rate-limits bursts (the relay logs each retry to `.surfpool/relay.log`), and on rare runs a request exhausts Surfpool's 30 s window; a free keyed endpoint avoids it. The fork's clock follows wall time; the suite aligns it with Surfpool's time-travel cheatcode only if it trails by more than 10 s, since price updates are fresh for 60 s. Measurements and the transaction trace are written to `tests/fork/reports/` (the Fork workflow uploads them).

Configure `.env` (see `.env.example`):

- `SURFPOOL_DATASOURCE_RPC_URL`: a mainnet RPC, for example a free Helius or QuickNode endpoint. Empty, the public `https://api.mainnet-beta.solana.com` is used, which works within its rate limits. In CI it is the repository secret of the same name.
- `PYTH_PRO_ACCESS_TOKEN`: the USDT sweep's USDT/USD update (repository secret of the same name).
- `JUPITER_API_KEY` (optional): a free key doubles Jupiter's rate limit to one request a second.

With a keyed RPC and a Jupiter key the suite takes about two minutes; with the public endpoint and keyless Jupiter it still passes, in two to four. An endpoint whose rate limit another process is using up slows it down: the suite waits and asks again, but a fork that cannot read mainnet for long fails its tests; `SURFPOOL_DATASOURCE_RPC_URL= just test-fork` falls back to the public endpoint.

`just measure-slippage [minutes]` samples how far tier-sized ($10 and $25) Jupiter quotes fall below the program's price bound (the oracle's worth at the conservative side of both confidence intervals, before `SLIPPAGE_BPS`), writing `tests/fork/reports/slippage-*.json` and printing the worst and median per session (regular NYSE hours, weekend, closed).

## Fuzzing

`fuzz/laterite` is a [Crucible](https://github.com/asymmetric-research/crucible) harness run through `anchor fuzz`: it loads the built program with the Subscriptions, Pyth Pro and CPMM binaries and the devnet accounts the program tests use, runs random sequences of every instruction with clock jumps, composed price updates and hostile routes, and checks one area's invariants after each step, judging NYSE sessions by its own New York clock and the calendar file. `just fuzz-build <target>` builds a target's harness (the first build compiles Crucible, LibAFL and LiteSVM and takes a few minutes), and `just fuzz <target> [seconds]` runs one of `invariant_sweep`, `invariant_attest`, `invariant_controls` and `invariant_admin`; `just fuzz-smoke` runs each for a minute, as CI does on every change (a nightly job runs two hours per target). The fuzzer exits 0 even when it finds crashes, so `just fuzz-check <target>` is what fails on them; `anchor fuzz show laterite` lists and replays them.

## Security

`just audit` checks the Rust and JavaScript dependencies against their advisory databases, with the reviewed exceptions in `.cargo/audit.toml` and in `pnpm-workspace.yaml` under `audit.ignore`, and `just scan` checks the program against the [Solana Security Standard](https://github.com/Copenhagen0x/solana-security-standard) with the reviewed findings in `.sss-baseline.json`; the Security workflow runs both on every change and daily. After reviewing a new finding, `just scan-baseline` rewrites the baseline. `docs/threat-model.md` states what each party can and cannot do.

## Program Administration

The program keeps one `Config` account with the admin, a kill switch (`set_paused`), beta caps (per-user weekly cap and maximum users), the allowed swap router, the attestor key, the key that sponsors users' onboarding, and the asset and payment-token tables. Only the program's upgrade authority can `initialize` it, which also fixes the asset and payment-token tables after checking them against the mint accounts; the swap router and the cluster's genesis hash are fixed there too. Afterwards `update_config` changes the attestor, sponsor and caps, and every change needs the stored admin.

The admin publishes four Subscriptions plans with `create_plan`: $10 and $25 a week, in USDC and USDT. Each is owned by the program's vault authority and pays only into the swap authority's accounts. A user joins with one transaction paid by the configured sponsor (see `docs/003-onboarding-transaction.md`) that ends in `enroll`, which is refused while the program is paused, when the beta is full or when the chosen tier is above the beta cap.

The program tests load the programs Laterite calls from committed fixtures in `programs/laterite/tests/fixtures/`, pinned by hash. `just dump-programs` refreshes them from mainnet and fails when a program no longer matches its pin; review the upstream change before updating the pin.

Admin handover takes two steps, so a mistyped key can never lock the program: the admin calls `propose_admin` with the new key, and the new key signs `accept_admin`. Proposing the default key cancels a pending handover.

To govern the program with a [Squads](https://squads.so) multisig, propose the multisig's vault address and execute `accept_admin` from a Squads proposal. The program has no Squads-specific code.

After changing the program, regenerate and commit its IDL and client:

```bash
just generate-clients
```

CI fails when they drift (`just check-generated`).

## Devnet

Devnet has no USDC, USDT or xStocks that Laterite can mint, and no venue that trades them, so the repository creates its own:

- USDC and USDT stand-ins (SPL Token, 6 decimals).
- SPYx and QQQx stand-ins. Each copies its mainnet mint's Token-2022 configuration; only authorities differ.
- Four pools (SPYx/USDC, SPYx/USDT, QQQx/USDC, QQQx/USDT) on our own deployment of [Raydium CPMM](https://github.com/raydium-io/raydium-cp-swap) (Apache-2.0), built from a pinned commit with only its devnet ids and admin keys replaced. See `docs/002-devnet-dex.md`.

The public addresses live in `packages/devnet/addresses.json`, and Laterite's deployment in `packages/devnet/deployment.json`.

```bash
just devnet-local          # a new local chain with devnet's programs, accounts and features (port 18899)
just devnet-assets local   # create or verify everything; `devnet` targets devnet itself
just test-devnet local     # parity with mainnet mints, swaps, re-peg, idempotency
just devnet-repeg local    # swap every pool back to the live mainnet price
```

### Laterite on devnet

`just devnet-deploy devnet` (or `local`, against the fork) takes the program from nothing to a configured deployment, and a second run sends nothing. On devnet it runs only with the keys the local rehearsal used: it refuses to start when a devnet key is missing or differs from the recorded deployment. Run `just devnet-preflight devnet` first: read-only, it prints what the upgrade authority and the issuer need at the cluster's current rent and checks the conditions below.

1. `just devnet-assets` creates or verifies the stand-ins, the CPMM and the pools.
2. `just deploy-program` writes the verifiable build of `laterite.so` into a buffer (`keys/devnet-laterite-buffer.json`), checks the buffer's executable hash, and deploys the program at `keys/laterite-program.json`, upgradeable by `devnet-authority`, unless the cluster already runs the same executable. The CPMM is deployed the same way. The upload holds about 4.2 SOL of the authority's balance while it runs, of which 2.09 SOL of program rent stays. An interrupted upload resumes from the same buffer on the next run; `solana program close <buffer> -u devnet --keypair keys/devnet-authority.json` returns an abandoned buffer's rent. Upgrading a program that runs another executable asks for its address first (see Upgrading the program).
3. `packages/deployment` initializes the config as the upgrade authority, with the CPMM as router, the stand-ins as the asset and payment-token tables, the recorded attestor and sponsor public keys and the genesis hash read from the cluster's RPC; creates the four plans and the swap authority's USDC and USDT accounts; loads the NYSE calendar from `programs/laterite/data/nyse-calendar.json`; creates and freezes the onboarding lookup table; funds the sponsor; and records the public addresses in `packages/devnet/deployment.json` as it goes, the lookup table's before it is created. To create another table, delete `lookupTable` from the record and run the deploy again.

The router, the asset and payment-token tables and the genesis hash are fixed at `initialize`, so a run against a config that holds others stops: changing them takes a new program. The attestor and the sponsor change only with `just rotate-key devnet attestor|sponsor`, which generates the new key, sets it with `update_config`, records it and keeps the retired key in `keys/retired/`: a retired sponsor still signs the Restore of subscriptions it paid for. A changed cap is applied with `update_config` on the next deploy.

```bash
just verify-program devnet  # rebuild the pushed program from GitHub, compare it and record the verification on-chain
just deploy-idl devnet      # publish the IDL with the Program Metadata program
just test-deployment devnet # check the deployment against the build and the committed configuration, and Pyth Pro there
just devnet-smoke devnet    # re-peg, then enroll and sweep a fresh wallet per payment token (PYTH_PRO_ACCESS_TOKEN in .env)
```

`local` runs every command above against `just devnet-local`: a new chain on Agave's test validator, the client devnet runs, with devnet's feature set and a copy of every devnet program and account the deployment uses, so a rehearsal sends the transactions devnet will. Its rent is the validator's genesis rate (6,960 lamports a byte, above devnet's), which the preflight reads like any cluster's.

#### Upgrading the program

After a program change, rehearse the upgrade on a local copy of the devnet deployment, then run it on devnet:

```bash
just devnet-local deployed      # a local chain with the devnet program, its accounts and record, upgradeable by devnet-authority
just devnet-preflight local     # the upgrade buffer (returned), any program data extension (kept) and fees
just deploy-program local       # type the program's address to upgrade it
just devnet-smoke local         # the upgraded program sweeps with the client's minimum output
```

`just deploy-program devnet` writes the new build into the kept buffer, checks its executable hash, extends the program's data first when the build is larger (`solana program extend`: the loader never grows it on its own, and an upgrade to a larger build fails without it), and upgrades with `solana program upgrade`, which returns the buffer's rent. The config, plans and accounts stay as they are, so `devnet-deploy`'s configuration sends nothing. Then push the commit and run `just verify-program devnet`, `just test-deployment devnet` and `just devnet-smoke devnet`. On the local copy, only the checks that hold on another chain apply: its genesis hash is its own and it has no devnet history, so the config's genesis hash and the recorded `MarketCalendarSet` are checked on devnet only.

To hand the program to a Squads vault, run `just propose-admin devnet <vault>` and execute `accept_admin` from a vault proposal, then move the upgrade authority with `solana program set-upgrade-authority LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf --new-upgrade-authority <vault> --skip-new-upgrade-authority-signer-check --upgrade-authority keys/devnet-authority.json -u devnet`. From then on the recipes that need the admin print the instruction to propose instead of sending it, and upgrades, IDL updates (`program-metadata … --export`) and verification PDAs are Squads proposals.

#### Market calendar

`initialize` leaves the calendar empty, and until it is loaded the weekly engine buys nothing. When the NYSE publishes a new year or announces an unscheduled closure, and at the latest when the operations alarm fires 90 days before `validThrough`, update `programs/laterite/data/nyse-calendar.json` with the full current list and run `just market-calendar devnet`. It sends `set_market_calendar` only when the config does not hold the file and prints the `MarketCalendarSet` event. When the admin has been handed to a Squads vault, it prints the instruction for a vault proposal instead.

### Keys

All keys live in `keys/` (git-ignored). The shared keys also live in the team password manager.

| Key                                                        | Holds                                                                                               | Stored                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `devnet-issuer`                                            | CPMM upgrade authority and admin; every SPYx/QQQx authority; USDC/USDT freeze authority; pays setup | `keys/` and password manager; never on a server |
| `devnet-faucet`                                            | USDC/USDT mint authority                                                                            | `keys/`, password manager, app host secret      |
| `devnet-treasury`                                          | Pool creator and LP owner, re-peg trader, token inventory                                           | `keys/`, password manager, service host secret  |
| `devnet-cpmm`                                              | CPMM program address                                                                                | `keys/`                                         |
| `devnet-usdc`, `devnet-usdt`, `devnet-spyx`, `devnet-qqqx` | Mint addresses                                                                                      | `keys/`                                         |
| `laterite-program`                                         | Laterite's program address                                                                          | `keys/` and password manager                    |
| `devnet-authority`                                         | Laterite's upgrade authority and admin on devnet; pays the deployment                               | `keys/` and password manager; never on a server |
| `devnet-attestor`                                          | `Config.attestor` on devnet, never reused on another cluster                                        | `keys/`, password manager, service host secret  |
| `devnet-sponsor`                                           | `Config.sponsor` on devnet: pays and co-signs onboarding and returns                                | `keys/`, password manager, app host secret      |
| `devnet-crank`                                             | The service's fee and rent payer: sweeps, attestations and their records                            | `keys/`, password manager, service host secret  |
| `devnet-laterite-buffer`, `devnet-cpmm-buffer`             | Program upload buffers, kept so an interrupted upload resumes                                       | `keys/`                                         |

The faucet and treasury keys never share a host, nor do the sponsor and the attestor; the issuer and the authority keys are never deployed.

## Services

`services/operator` is one always-on process on Railway, next to its Postgres. It stores Laterite's history from finalized devnet transactions, whoever sent them, and watches what keeps sweeps running:

- **History:** every sweep from its `Swept` event (read from Laterite's self-CPI among the inner instructions, never from logs) with the asset's ScaledUiAmount multiplier in force at its block time, which the program does not read; every attestation from `Attested` with its record, payer and expiry, and the record's closing; and each user's controls (enrollment, settings, pause and resume, lowering what waits to invest, tier and payment-token changes, exit, return) from the events Laterite logs. Instructions are told apart by their discriminator. The indexer resumes after the last transaction it stored and stores nothing twice.
- **Alarms:** the crank's and the sponsor's SOL and the treasury's SOL and inventory; the market calendar 90 days before `validThrough`, and at once when it does not cover today; Kamino Scope's SPYX/USD and QQQX/USD posts older than 120 s, missing, or larger than a sweep has room for; Pyth Pro answering 401, 403 or 429 to the USDT/USD request; the crank's latest sweep landing less than 20 bps above `min_out`; more swap-authority accounts created in a day than the bound; the indexer stalling. Each alarm is logged and posted to `ALERT_WEBHOOK_URL`, a Slack incoming webhook or a Discord one followed by `/slack`, when it starts, every six hours while it lasts and when it resolves. The Fork workflow's weekday run posts there when it fails.

Only one process operates at a time (a Postgres advisory lock), so a deploy's new process waits as a healthy standby until the old one exits. `GET /health` answers 200 when the database answers and the indexer is current.

The schema lives in `packages/db/src/schema.ts`; `pnpm --filter @laterite/db generate` writes a migration for a change, `just db-check` fails when the committed migrations differ from the schema, and `just db-migrate` applies them. Railway applies them before each deploy (`node migrate.js` in the image).

```bash
eval "$(just db-up)"   # a disposable Postgres 18; `just db-down` removes it
just services-test     # the schema, the service and the indexer against real transactions on a local validator (port 28899)
just operator-image    # the image Railway builds
```

### Railway

`.railway/railway.ts` declares the project: the Postgres and the `operator` service, built from `services/operator/Dockerfile` at the repository's `main`, migrated before each deploy, gated on `/health`, one replica. Apply it with the Railway CLI (`railway config plan`, then `railway config apply`). Secrets never enter the repository: set each with `railway variable set <NAME> --stdin --service operator`, reading the value from its file or `.env` so it never appears on a command line:

| Variable                                      | Value                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `CRANK_KEYPAIR`                               | `keys/devnet-crank.json`: the service's fee and rent payer            |
| `SOLANA_RPC_URL`                              | A devnet RPC                                                          |
| `MAINNET_RPC_URL`, `MAINNET_FALLBACK_RPC_URL` | Two mainnet RPCs from different providers, for the Kamino Scope relay |
| `PYTH_PRO_ACCESS_TOKEN`                       | The Pyth Pro token (never logged, never sent to the app or a browser) |
| `ALERT_WEBHOOK_URL`                           | The operations channel's incoming webhook                             |

`DATABASE_URL` references the Postgres, and Railway sets `PORT`. The service refuses to start when a variable is missing or malformed, naming it, and when its RPC's genesis hash is not the one Laterite's config holds.

## License

MIT
