# ADR-002: Devnet DEX

**Status:** Accepted
**Date:** 2026-09-21

## Context

Laterite swaps stablecoins into xStocks through an allowed router: Jupiter on mainnet and on the mainnet fork. Devnet has neither the xStocks nor a venue that trades them, so the devnet environment needs its own mints and pools. The SPYx and QQQx stand-ins keep the full mainnet extension set: MetadataPointer, PermanentDelegate, DefaultAccountState, ScaledUiAmount, Pausable, ConfidentialTransferMint, TransferHook and TokenMetadata, plus a freeze authority.

Each existing devnet deployment rejects that mint unless its operator allowlists it:

| DEX (devnet)    | Result                                                                               |
| --------------- | ------------------------------------------------------------------------------------ |
| Orca Whirlpools | `UnsupportedTokenMint` (6047) without a TokenBadge from the config's badge authority |
| Raydium CPMM    | `NotSupportMint` (6007) without a `SupportMintAssociated` entry from the admin       |
| Meteora DAMM v2 | `InvalidTokenBadge` without an operator badge                                        |
| Manifest        | `InvalidAccountData`: the devnet build predates ScaledUiAmount and Pausable          |

Self-hosting is the remaining option, and licenses decide which code can be self-hosted:

- Orca Whirlpools (Orca License) and Meteora DAMM v2 (noncommercial licence) restrict use.
- Manifest is GPL-3.0.
- Raydium CPMM and CLMM are Apache-2.0.

## Decision

Devnet runs our own deployment of `raydium-io/raydium-cp-swap` at commit `59fb845a9e5bb569c8b2f3415f13b0c0ebcc6b92` (Apache-2.0). It is built with the `devnet` feature. Only these constants change, and all are set by `just build-cpmm`:

| Constant                                                                               | Value                                  |
| -------------------------------------------------------------------------------------- | -------------------------------------- |
| program id                                                                             | `keys/devnet-cpmm.json`                |
| admin, lamport collector, fund and protocol fee owner, whitelist and permission owners | the devnet issuer                      |
| pool-fee receiver                                                                      | the issuer's wrapped-SOL token account |

The issuer then creates AmmConfig index 0 (0.25% trade fee, 12% protocol and 4% fund shares, no pool-creation fee). It also whitelists the SPYx and QQQx stand-ins with `create_support_mint_associated`, the path Raydium uses for real SPYx on mainnet.

Why CPMM over the other Apache-2.0 candidate, CLMM (both measured on a mainnet fork with the full-extension mint):

|                    | CPMM        | CLMM                            |
| ------------------ | ----------- | ------------------------------- |
| Swap compute units | 29.2k       | 44.6k–54.1k                     |
| Swap accounts      | 13 fixed    | 13 fixed + bitmap + tick arrays |
| Program rent       | about 4 SOL | about 8.6 SOL                   |

A CPMM re-peg is exact in one swap with the closed form in `packages/devnet/src/repeg.ts`: a mainnet-fork pool moved 774.25 → 789.99999999.

These pools are our deployment of open-source code, not a third-party venue.

## Consequences

- Build: sha256 `6c6d893d4f43f6d747f18b2130482a7259d1ad27cc98cee36dd2451cdec00dc3`, 688,968 bytes, reproducible across clean builds. Deploy cost: 3.50 SOL of program rent on devnet, plus a buffer of the same size during the deploy.
- The CPMM program id is the Laterite program's allowed router on devnet. The program calls it through the same generic CPI it uses for Jupiter; off-chain builders supply `swap_base_input`, which takes 13 fixed accounts and no remaining accounts.
- PermanentDelegate and Pausable remain issuer powers. CPMM prices from vault balances, so a delegate transfer out of a vault moves the price, and pausing a mint halts its pools. On devnet the issuer is us.
- A non-null TransferHook would break every candidate; mainnet SPYx has none.
- Direct USDT pools exist only on devnet. On mainnet USDT reaches SPYx through Jupiter, and the program never assumes a direct route.
- Pools are re-pegged to the raw-unit price, the unit Pyth quotes xStocks in, never multiplied by the ScaledUiAmount multiplier.

## Evidence

On a local Surfpool fork of devnet, from empty keys to a full setup:

- `just devnet-assets local`: 15 transactions create the four mints, the CPMM config, the whitelist entries, the treasury inventory and the four pools; a second run sends none and leaves `packages/devnet/addresses.json` unchanged.
- `just test-devnet local`: 17 tests pass. The SPYx and QQQx replicas match mainnet except authorities; a fresh wallet swaps 25 USDC or USDT into each xStock with no thaw step; a pushed pool returns to within 1 bp of the live price in one swap.
- `swap_base_input` on our build: 26,213 to 26,517 compute units, 13 accounts.
