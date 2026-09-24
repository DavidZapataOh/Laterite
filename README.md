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
packages/deployment/ Deployment runbooks, their checks and the devnet smoke
packages/devnet/     Devnet stand-in assets, pools and re-peg
programs/laterite/   On-chain program (Anchor)
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
8. Devnet assets: nothing more. `just build-cpmm` builds the DEX in the verifiable-build image of the Solana version its source pins (3.1.10), and the Solana CLI's `solana-test-validator` runs the local devnet.

## Quick Start

```bash
just setup
just build
just test
just check
```

Run `just` to list every recipe.

## Fork Testing

`just test-fork` boots a Surfpool mainnet fork (datasource from `SURFPOOL_DATASOURCE_RPC_URL` in `.env`), installs the program at its declared address and runs `tests/fork`. It needs network access and is not part of `just test`. Swap routes are restricted to classic pools on the fork because market-maker pools depend on quote accounts that go stale once cloned.

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
2. `just deploy-program` writes the verifiable build of `laterite.so` into a buffer (`keys/devnet-laterite-buffer.json`), checks the buffer's executable hash, and deploys the program at `keys/laterite-program.json`, upgradeable by `devnet-authority`, unless the cluster already runs the same executable. The CPMM is deployed the same way. The upload holds about 4.2 SOL of the authority's balance while it runs, of which 2.09 SOL of program rent stays. An interrupted upload resumes from the same buffer on the next run; `solana program close <buffer> -u devnet --keypair keys/devnet-authority.json` returns an abandoned buffer's rent. Upgrading a program that runs another executable asks for its address first.
3. `packages/deployment` initializes the config as the upgrade authority, with the CPMM as router, the stand-ins as the asset and payment-token tables, the recorded attestor and sponsor public keys and the genesis hash read from the cluster's RPC; creates the four plans and the swap authority's USDC and USDT accounts; loads the NYSE calendar from `programs/laterite/data/nyse-calendar.json`; creates and freezes the onboarding lookup table; funds the sponsor; and records the public addresses in `packages/devnet/deployment.json` as it goes, the lookup table's before it is created. To create another table, delete `lookupTable` from the record and run the deploy again.

The router, the asset and payment-token tables and the genesis hash are fixed at `initialize`, so a run against a config that holds others stops: changing them takes a new program. The attestor and the sponsor change only with `just rotate-key devnet attestor|sponsor`, which generates the new key, sets it with `update_config`, records it and keeps the retired key in `keys/retired/`: a retired sponsor still signs the Restore of subscriptions it paid for. A changed cap is applied with `update_config` on the next deploy.

```bash
just verify-program devnet  # rebuild the pushed program from GitHub, compare it and record the verification on-chain
just deploy-idl devnet      # publish the IDL with the Program Metadata program
just test-deployment devnet # check the deployment against the build and the committed configuration, and Pyth Pro there
just devnet-smoke devnet    # re-peg, then enroll and sweep a fresh wallet per payment token (PYTH_PRO_ACCESS_TOKEN in .env)
```

`local` runs every command above against `just devnet-local`: a new chain on Agave's test validator, the client devnet runs, with devnet's feature set and a copy of every devnet program and account the deployment uses, so a rehearsal sends the transactions devnet will. Its rent is the validator's genesis rate (6,960 lamports a byte, above devnet's), which the preflight reads like any cluster's.

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
| `devnet-laterite-buffer`, `devnet-cpmm-buffer`             | Program upload buffers, kept so an interrupted upload resumes                                       | `keys/`                                         |

The faucet and treasury keys never share a host, nor do the sponsor and the attestor; the issuer and the authority keys are never deployed.

## License

MIT
