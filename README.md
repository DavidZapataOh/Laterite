# Laterite

Get paid. Lay a brick. A non-custodial autopilot on Solana that turns a capped slice of every payday into tokenized S&P 500, straight from your own wallet.

## Program ID

```
LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf
```

## Project Structure

```
apps/landing/        Marketing site (Next.js)
programs/laterite/   On-chain program (Anchor)
```

## Prerequisites

1. Rust (rustup); the toolchain in `rust-toolchain.toml` installs itself.
2. Solana CLI 4.1.2: `sh -c "$(curl -sSfL https://release.anza.xyz/v4.1.2/install)"`
3. Anchor 1.2.0: `cargo install --git https://github.com/otter-sec/anchor avm --locked --force && avm install 1.2.0 && avm use 1.2.0`
4. Node 24.14.0 (`.nvmrc`) and pnpm (the version in `package.json` is fetched automatically).
5. just: `brew install just`

## Quick Start

```bash
just setup
just build
just test
just check
```

Run `just` to list every recipe.

## License

MIT
