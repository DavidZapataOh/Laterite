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
docs/                Architecture decision records
idl/                 Program IDL
packages/devnet/     Devnet stand-in assets, pools and re-peg
programs/laterite/   On-chain program (Anchor)
tests/fork/          Mainnet-fork tests (Surfpool)
```

## Prerequisites

1. Rust (rustup); the toolchain in `rust-toolchain.toml` installs itself.
2. Solana CLI 4.1.2: `sh -c "$(curl -sSfL https://release.anza.xyz/v4.1.2/install)"`
3. Anchor 1.2.0: `cargo install --git https://github.com/otter-sec/anchor avm --locked --force && avm install 1.2.0 && avm use 1.2.0`
4. Node 24.14.0 (`.nvmrc`) and pnpm (the version in `package.json` is fetched automatically).
5. just: `brew install just`
6. Surfpool 1.6.0 (fork tests): `curl -sL https://run.surfpool.run/ | VERSION=v1.6.0 bash`, and a mainnet RPC URL in `.env` (see `.env.example`).
7. Devnet assets: Anchor 1.0.2 through `avm` and Agave installed with `agave-install` (the DEX source pins Agave 3.1.10; `just build-cpmm` switches to it for the build and back), plus Surfpool (above).

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

## Program Administration

The program keeps one `Config` account with the admin, a kill switch (`set_paused`), beta caps (per-user weekly cap and maximum users), the allowed swap router, the attestor key, the key that sponsors users' onboarding, and the asset and payment-token tables. Only the program's upgrade authority can `initialize` it, which also fixes the asset and payment-token tables after checking them against the mint accounts; afterwards `update_config` changes the router, attestor, sponsor and caps, and every change needs the stored admin.

The admin publishes four Subscriptions plans with `create_plan`: $10 and $25 a week, in USDC and USDT. Each is owned by the program's vault authority, which is also its only destination. A user joins with one transaction paid by the configured sponsor (see `docs/003-onboarding-transaction.md`) that ends in `enroll`, which is refused while the program is paused, when the beta is full or when the chosen tier is above the beta cap.

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

The public addresses live in `packages/devnet/addresses.json`.

```bash
just devnet-local          # local Surfpool forking devnet (port 18899)
just devnet-assets local   # create or verify everything; `devnet` targets devnet itself
just test-devnet local     # parity with mainnet mints, swaps, re-peg, idempotency
just devnet-repeg local    # swap every pool back to the live mainnet price
```

### Keys

All keys live in `keys/` (git-ignored). The shared keys also live in the team password manager.

| Key                                                        | Holds                                                                                               | Stored                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `devnet-issuer`                                            | CPMM upgrade authority and admin; every SPYx/QQQx authority; USDC/USDT freeze authority; pays setup | `keys/` and password manager; never on a server |
| `devnet-faucet`                                            | USDC/USDT mint authority                                                                            | `keys/`, password manager, app host secret      |
| `devnet-treasury`                                          | Pool creator and LP owner, re-peg trader, token inventory                                           | `keys/`, password manager, service host secret  |
| `devnet-cpmm`                                              | CPMM program address                                                                                | `keys/`                                         |
| `devnet-usdc`, `devnet-usdt`, `devnet-spyx`, `devnet-qqqx` | Mint addresses                                                                                      | `keys/`                                         |

The faucet and treasury keys never share a host, and the issuer key is never deployed.

## License

MIT
