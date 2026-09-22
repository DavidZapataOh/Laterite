# ADR-003: Onboarding Transaction

**Status:** Accepted
**Date:** 2026-09-21

## Context

A user joins with one wallet signature. The transaction creates the asset's associated token account, then, for each enabled payment token, the Subscriptions authority and the subscription to the chosen weekly plan, and finally the user's settings through `enroll`. The configured sponsor pays the fee and every rent, so the user needs no SOL. Version 1 transactions are active on mainnet and devnet, but as of September 2026 Phantom, Solflare and Backpack advertise only legacy and version 0 transactions through Wallet Standard.

Without a lookup table the transaction takes 1,228 of the 1,232 bytes a version 0 transaction allows, which leaves no room for Compute Budget instructions.

## Decision

The onboarding transaction is version 0 and uses one address lookup table, created at deployment, that holds the accounts every onboarding shares:

- the System, SPL Token, Token-2022, Associated Token Account, Subscriptions and Laterite programs;
- the Subscriptions event authority;
- Laterite's config and vault authority;
- the two asset mints, the two payment-token mints and the four plans.

A transaction never loads a program it calls from a table, and each onboarding uses one asset mint and one tier's plans, so an onboarding with both payment tokens loads 11 of the 17 entries.

Measured in LiteSVM with the mainnet Subscriptions binary:

| Onboarding                                | Without the table | With the table |
| ----------------------------------------- | ----------------- | -------------- |
| Both payment tokens                       | 1,228 bytes       | 921 bytes      |
| Both, with a compute-unit limit and price | 1,280 bytes       | 973 bytes      |
| USDC only                                 | 970 bytes         | 725 bytes      |

With the compute-unit limit and price, 259 bytes remain. The transaction takes 60,150 to 93,150 compute units, 70,822 on average over 200 random users; the spread comes from the bump searches for the user's own accounts.

A client may send version 1 only to a wallet that advertises it.

`init_subscription_authority` and `subscribe` in the same transaction use the `UNKNOWN_INIT_ID` sentinel (`i64::MIN`); a later subscription passes the authority's stored `init_id`.

## Consequences

- The deployment creates and extends the table, and onboarding can use it from the next slot. Clients are configured with its address. Its rent, 5,066,880 lamports for 600 bytes, is paid once.
- Clients add a compute-unit limit and price to every onboarding.
- Only the configured sponsor can pay for `enroll`. It is recorded as payer of the Subscriptions authority and subscription, so closing them refunds it. Plan rent is paid once by the admin and is not refundable.
- An account every onboarding shares goes into the table; one per user costs 32 bytes. The program tests assert the 1,232-byte limit.
