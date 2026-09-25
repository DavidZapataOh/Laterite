# Laterite

Get paid. Lay a brick. A non-custodial autopilot on Solana that turns a capped slice of every payday into tokenized S&P 500, straight from your own wallet.

## Program ID

```
LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf
```

## Project Structure

```
apps/app/            The product app (Next.js): wallets, eligibility and the account's state
apps/landing/        Marketing site (Next.js)
clients/typescript/  Generated TypeScript client (Codama)
docs/                Architecture decision records and the threat model
fuzz/laterite/       Invariant fuzz harness (Crucible, `anchor fuzz`)
idl/                 Program IDL
packages/db/         Postgres schema and migrations (Drizzle), shared by the services and the app
packages/deployment/ Deployment runbooks, their checks and the devnet smoke
packages/devnet/     Devnet stand-in assets, pools and re-peg
packages/i18n/       Locales and messages (English, Spanish for Argentina), shared by the apps and the services
packages/ui/         The design system the apps share: tokens, fonts, buttons, chips, the Seal and brand assets
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
9. App: Playwright's Chromium for its browser tests (`pnpm --filter @laterite/app exec playwright install chromium`).
10. Devnet assets: nothing more. `just build-cpmm` builds the DEX in the verifiable-build image of the Solana version its source pins (3.1.10), and the Solana CLI's `solana-test-validator` runs the local devnet.

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
- runs the crank's own code (`services/operator`'s `Crank` with its Jupiter routes, the Kamino Scope relay and the Pyth Pro updates) on three enrolled wallets, through any venue: it excludes a venue whose fork state fails a sweep and builds again, creates the swap authority's account a route needs, and records every attempt in Postgres (`DATABASE_URL`, as for `just services-test`).

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

`services/operator` is one always-on process on Railway, next to its Postgres. It stores Laterite's history from finalized devnet transactions, whoever sent them, attests the users' payments, and watches what keeps sweeps running:

- **History:** every sweep from its `Swept` event (read from Laterite's self-CPI among the inner instructions, never from logs) with the asset's ScaledUiAmount multiplier in force at its block time, which the program does not read; every attestation from `Attested` with its record, payer and expiry, and the record's closing; and each user's controls (enrollment, settings, pause and resume, lowering what waits to invest, tier and payment-token changes, exit, return) from the events Laterite logs. Instructions are told apart by their discriminator. The indexer resumes after the last transaction it stored and stores nothing twice.
- **Sweeps:** every 30 seconds the crank reads every `UserConfig` and sweeps each active user's enabled payment token that is due today and was not swept today: a daily-engine user at any hour, a weekly-engine user only inside a regular NYSE session of `Config.market_calendar` (none while the calendar does not cover today, `pending` included, as the program decides), and nothing while the kill switch is on. Right before building it reads the cluster's state (the builders' `getSweepPull`: a token ended outside Laterite is skipped until the user restores it) and waits out the 15 seconds before a boundary that changes the pull. Each sweep carries Kamino Scope's latest SPYX/USD or QQQX/USD update, at most 45 seconds old by its feed's own time (the relay follows Scope's posts through a mainnet subscription and polls while it is silent, asking the fallback provider for a post the primary returns as `null`), and for USDT a USDT/USD update fetched with `PYTH_PRO_ACCESS_TOKEN` (one serves 20 seconds of sweeps); both are checked against the cluster's Pyth Pro storage. On devnet the treasury first trades the sweep's pool back within 10 bps of those prices, and every 30 seconds re-pegs every pool to the latest updates (to Jupiter's keyless prices only while no fresh update is available), never trading a pool more than 500 bps away. A route whose quote falls below `min_out` is not sent. The sweep is one version 1 transaction with every account inline, simulated first; its compute and loaded-accounts limits are the simulation's plus 10% (never above 490,000 units) and its priority fee the recent fees' price on its writable accounts times that limit. What a failure means follows the program's error and the program that raised it: a changed pull is built again once, a stale or uncertain price and a route below `min_out` are retried later in the day (the day is skipped if they never pass), a sweep someone else landed is final, a pull Subscriptions or the token program refuses is a pull failure not retried that day, and an error the local checks should have caught alarms. Every attempt, and each day's final word on a token (landed, skipped, a pull failure, swept by someone else), is a row of `sweep_attempts` with its reason, pull, `min_out`, route, the price update's age, size, limits, fee and latency.
- **Attestations:** for each active user whose income rule or change per payment is on, the service watches their associated account in each enabled payment token (an account notification per finalized change, and every account read again every five minutes) and reads its finalized transactions after the last one it handled. Each transfer into the account is an income and each transfer out of it a payment, except zero amounts and transfers with another account of the same owner or with the swap authority (a sweep's pull). A transfer's index counts the transaction's USDC and USDT transfers to or from the user, in the order they ran, so every copy of the transaction numbers it alike. Right before signing, the service reads the user's `UserConfig` and signs nothing the program would refuse (a paused or exited user, a transfer from before `attestableFrom` or older than 7 days, a token the user did not enable, a rule that invests nothing) or has already counted; it signs nothing at all unless `Config.attestor` is its key and `Config.genesisHash` is its RPC's cluster. Each attestation is its own transaction, the crank paying the fee and the record's rent, its compute limit from the simulation plus 10% and its price the 75th percentile of the recent fees on its accounts, within 1,000 and 1,000,000 micro-lamports. Expired records the crank paid for are closed, the rent back to it.
- **Telegram:** the product bot (`TELEGRAM_BOT_TOKEN`) writes to the chats users link from the app. `/start` with the one-time token of a wallet's signed link request (`POST /api/telegram`, below) links the private chat that sent it; `/unlink` revokes every link of the chat, as a wallet's signed unlink request revokes every chat of the wallet, and a chat that blocks the bot is unlinked. It reads messages by long polling, so only the process holding the lock talks to Telegram and nothing is exposed. From the indexed history it sends each purchase (the amount, the part from payments, what the asset bought, and when the week's cap stops a buy, the cap and what waits for next week), each goal milestone (25, 50, 75 and 100% of the goal invested), a confirmation of each pause, resume, tier change, payment-token change, exit and return, and each day a token was not bought (the crank's final word: a token ended outside Laterite once, not every day until it is restored). A paused user gets no skipped-day notice, a weekly buy waiting for the next session is not a skipped day (the crank records none), and after an exit nothing but the exit is sent until the return. Each notification is recorded before it is sent, so a restart never repeats one; messages come from `packages/i18n` in the locale the wallet linked in.
- **Alarms:** the crank's and the sponsor's SOL and the treasury's SOL and inventory; the market calendar 90 days before `validThrough`, and at once when it does not cover today; Kamino Scope's SPYX/USD and QQQX/USD posts older than 120 s, missing, or larger than a sweep has room for; Pyth Pro answering 401, 403 or 429 to the USDT/USD request; the crank's latest sweep landing less than 20 bps above `min_out` (5 on devnet, whose pools charge 25 bps and move within the 10 bps re-peg band); the crank reaching its bound of five new swap-authority accounts a day; a sweep failing a way the local checks should catch, needing more than 490,000 compute units, not fitting 4,096 bytes, or changing a swap-authority account twice (that route is skipped for the day); a devnet pool the re-peg refuses; the indexer stalling; the attestor's key or cluster not matching `Config`, the program refusing its signature, and the watcher failing to read its accounts. Each alarm is logged and sent to the operations chat through its own Telegram bot (`OPS_TELEGRAM_BOT_TOKEN`, `OPS_TELEGRAM_CHAT_ID`; never the product's bot) when it starts, every six hours while it lasts and when it resolves. The Fork workflow's weekday run alerts there when it fails.

Only one process operates at a time (a Postgres advisory lock), so a deploy's new process waits as a healthy standby until the old one exits. `GET /health` answers 200 when the database answers, the indexer, the watcher and the crank are current, and `Config` names the attestor's key on the RPC's cluster; it also reports the records the crank holds open and the rent they lock, the age of each relayed asset update and the day's sweep attempts by outcome.

The schema lives in `packages/db/src/schema.ts`; `pnpm --filter @laterite/db generate` writes a migration for a change, `just db-check` fails when the committed migrations differ from the schema, and `just db-migrate` applies them. Railway applies them before each deploy (`node migrate.js` in the image).

```bash
eval "$(just db-up)"   # a disposable Postgres 18; `just db-down` removes it
just services-test     # the schema and the service: the indexer, the watcher and the crank against real transactions on local validators (ports 28899, 28999 and 29099), the crank's schedule on LiteSVM's clock
just operator-image    # the image Railway builds
```

### Railway

`.railway/railway.ts` declares the project: the Postgres and the `operator` service, built from `services/operator/Dockerfile` at the repository's `main`, migrated before each deploy, gated on `/health`, one replica. Apply it with the Railway CLI (`railway config plan`, then `railway config apply`). Secrets never enter the repository: set each with `railway variable set <NAME> --stdin --service operator`, reading the value from its file or `.env` so it never appears on a command line:

| Variable                                         | Value                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `CRANK_KEYPAIR`                                  | `keys/devnet-crank.json`: the service's fee and rent payer, which signs sweeps |
| `ATTESTOR_KEYPAIR`                               | `keys/devnet-attestor.json`: `Config.attestor`, signs attestations only        |
| `TREASURY_KEYPAIR`                               | `keys/devnet-treasury.json`: re-pegs the devnet pools, read only by the crank  |
| `SOLANA_RPC_URL`                                 | A devnet RPC                                                                   |
| `SOLANA_WS_URL`                                  | Its WebSocket endpoint, when not the same URL on `wss://`                      |
| `MAINNET_RPC_URL`, `MAINNET_FALLBACK_RPC_URL`    | Two mainnet RPCs from different providers, for the Kamino Scope relay          |
| `MAINNET_WS_URL`                                 | The first one's WebSocket endpoint, when not the same URL on `wss://`          |
| `PYTH_PRO_ACCESS_TOKEN`                          | The Pyth Pro token (never logged, never sent to the app or a browser)          |
| `JUPITER_API_KEY`                                | Optional, for a deployment whose router is Jupiter: one request a second       |
| `OPS_TELEGRAM_BOT_TOKEN`, `OPS_TELEGRAM_CHAT_ID` | The operations bot's token and the chat it alerts                              |
| `TELEGRAM_BOT_TOKEN`                             | The product bot's token (never the operations bot's), from BotFather           |

`DATABASE_URL` references the Postgres, and Railway sets `PORT`. The service refuses to start when a variable is missing or malformed, naming it, when the attestor's key is the crank's, when the treasury's key is not the devnet treasury, when the product bot is the operations bot or Telegram refuses its token, and when its RPC's genesis hash is not the one Laterite's config holds.

## Landing

`apps/landing` is the marketing page, served at laterite.cash: English at `/` and Spanish (Argentina) at `/es`, each statically rendered with its own Open Graph and Twitter card, generated at build. Its words come from the `landing` namespace of `packages/i18n`, whose test holds them to the page's word budget in every locale; `just landing-test` checks the locales, the language switch, every link and the cards, and `just test-visual` compares both locales with their screenshot baselines.

## App

`apps/app` is the product app, served at app.laterite.cash: one screen whose layers open above it, built on `packages/ui`.

- **Wallets:** Phantom, Solflare and Backpack through Wallet Standard (`@solana/kit-plugin-wallet`). The wallet is the user's identity and never pays: Laterite's sponsor pays every fee. Inside a wallet's own browser one tap connects; elsewhere the wallet layer opens the app inside each wallet's browser. The connected wallet's `UserConfig` tells a new wallet, an exited account (it stays) and an active or paused enrollment apart.
- **Languages:** English at `/`, Spanish (Argentina) at `/es`, from `packages/i18n` (next-intl), the one set of locales and messages for every surface.
- **Availability:** `proxy.ts` reads Vercel's `x-vercel-ip-country` and `x-vercel-ip-country-region` and answers requests from where the issuer of xStocks does not offer them with the unavailable screen, and the API with an error, both as 451. The list is `apps/app/lib/geo.ts`, from the issuer's [restricted countries](https://assets.backed.fi/legal-documentation/restricted-countries).
- **Eligibility:** every wallet signs a short declaration once per version (a message, not a transaction). `POST /api/eligibility` rebuilds the text from the locale, the host, the wallet and the issue time, checks the wallet's signature and records the wallet, the country, the version, the text and the signature in `eligibility_declarations`.
- **Onboarding:** a wallet that never enrolled, or exited, sets its rules on the same screen: how it gets paid (which only picks defaults), the weekly cap (only those within `Config.userWeeklyCap`), the schedule, the income rule, change per payment, the cushion, the goal, the asset and the tokens (only those whose account the wallet holds). The band previews what a $1,000 payday would invest this week under those rules, computed with the program's own rules through `@laterite/client`'s mirrors. The choices become `EnrollParams` for `enroll`, or for `reactivate` when the account exited; an approval of another program on a token account must be confirmed, and nothing is offered while the program is paused or the beta is full.
- **Telegram:** a wallet links a Telegram chat by signing a short request (a message, not a transaction). `POST /api/telegram` rebuilds the text from the locale, the host, the wallet and the issue time, checks the signature (each signature makes one request) and answers the bot's link with a one-time token, kept only as its SHA-256 and valid for ten minutes; `GET /api/telegram?wallet=` says whether the wallet has a linked chat, and `DELETE /api/telegram` with a signed unlink request revokes every chat of the wallet.
- **Devnet faucet:** `POST /api/faucet` mints $100 of the devnet USDC and $100 of the devnet USDT stand-ins to a declared wallet, creating its accounts. It holds `devnet-faucet` (their mint authority, which pays the fee and the two accounts' rent: 2,981,880 lamports a grant at devnet's 5,080 lamports a byte) and allows one grant per wallet and three per requesting address in 24 hours, counted in `faucet_grants`.

| Variable                     | Where           | Value                                                                                |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | Build, browser  | A devnet RPC browsers may call (public devnet by default)                            |
| `DATABASE_URL`               | Server (Vercel) | Laterite's Postgres; from Vercel, Railway's public URL of it (`DATABASE_PUBLIC_URL`) |
| `FAUCET_KEYPAIR`             | Server (Vercel) | Secret: `keys/devnet-faucet.json`'s contents (a JSON array of 64 bytes)              |
| `SOLANA_RPC_URL`             | Server (Vercel) | The devnet RPC the faucet sends through                                              |
| `SOLANA_WS_URL`              | Server (Vercel) | Its WebSocket endpoint (the RPC URL on `wss://` by default)                          |
| `TELEGRAM_BOT_USERNAME`      | Server (Vercel) | The product bot's username, without `@`, for its start links                         |

```bash
eval "$(just db-up)"                  # a disposable Postgres 18
just app-test                         # build against local validators (ports 48899 and 49899), then unit, route and browser tests
pnpm --filter @laterite/app dev       # http://localhost:3401
```

## License

MIT
