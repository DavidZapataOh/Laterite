# Laterite

Get paid. Lay a brick. A non-custodial autopilot on Solana that turns a capped slice of every payday into tokenized S&P 500, straight from your own wallet.

## Program ID

```
LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf
```

## Project Structure

```
apps/landing/        Marketing site (Next.js)
docs/                Architecture decision records
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

## License

MIT
