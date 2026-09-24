# Threat model

What Laterite trusts, who can do what, and what each party could do if it turned hostile or lost its key. Amounts
are in USD; the weekly tiers are $10 and $25.

## Program

### Powers

| Role               | Who                                                   | Can                                                                                                                                                                                                                                                                                               | Cannot                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upgrade authority  | The program's loader authority                        | Replace the program, and so everything below. `initialize` also requires its signature, once.                                                                                                                                                                                                     | Nothing is out of its reach; it is the root of trust.                                                                                                                     |
| Admin              | `Config.admin`, the upgrade authority at `initialize` | Change the attestor (handing the attestor's power to the new key), the sponsor and the beta caps (`update_config`); set the kill switch (`set_paused`); load the NYSE calendar (`set_market_calendar`); create the four plans; hand over the role in two steps (`propose_admin`, `accept_admin`). | Change the router, the asset and payment-token tables or the genesis hash; move user funds; stop a user's controls.                                                       |
| Sponsor            | `Config.sponsor`                                      | Pay the fees and rent of onboarding and returns; `enroll` and `reactivate` require its signature. A leaked key can fill the free seats with wallets it controls and spend the sponsor's SOL on `UserConfig` rent, which is never refunded.                                                        | Enroll or return anyone without that user's signature.                                                                                                                    |
| Attestor           | `Config.attestor`, an ed25519 key, one per cluster    | Sign attestations of transfers a user made or received; each one raises that user's `pending` by what the user's own rules derive.                                                                                                                                                                | Sign a transaction (it signs only messages); pull anything by itself; exceed a user's weekly cap; choose a destination; count one transfer twice while its record exists. |
| Crank (any caller) | Anyone                                                | Sweep any active user once per payment token and UTC day; submit a signed attestation; close an expired attestation record.                                                                                                                                                                       | Choose the amount, the asset or the recipient of a sweep.                                                                                                                 |
| User               | The wallet a `UserConfig` names                       | Change their settings, tier and payment tokens; pause and resume; lower `pending`; exit; return with the sponsor.                                                                                                                                                                                 | Touch another user's settings or subscriptions; raise `pending`.                                                                                                          |

Two program addresses sign, and neither accepts a signature from outside:

- The **vault** (`["vault"]`) owns every plan. It signs `create_plan`, the pull inside `sweep` (`transfer_subscription`, into the swap authority's account) and, with the user, `cancel_subscription_now` inside `change_tier`, `change_payment_tokens` and `exit`. It never signs a route.
- The **swap authority** (`["swap"]`) is every plan's only destination and the only signer of a sweep's route. Its signature moves only its own token accounts, and the sweep requires each of them to end byte for byte as it started, with no new one appearing. Subscriptions refuses it as a puller of any subscriber (`Unauthorized`) and as a plan's owner (`NotPlanOwner`).

### Deployment binding

`initialize` stores the cluster's genesis hash, which only a new deployment can change. Every attestation signs the
program's address and that hash, so a signature made for another cluster or another deployment is refused. The
program cannot read the genesis hash, so the deployment supplies it and its runbook asserts the stored value; a wrong
value makes every attestation fail, never succeed elsewhere. Each cluster also has its own attestor key, which is what
separates a mainnet fork from mainnet. The deployment creates, extends and freezes the onboarding lookup table in one
transaction, so no key can change the addresses a sponsored transaction resolves through it.

### The attestor key

Variable amounts carry over, so a leaked attestor key can raise `pending` without limit for any active user: one
invented income is enough, since the amount is signed. It costs the attacker only fees and record rent, which it gets
back. What `pending` buys stays bounded: every sweep is within the user's weekly cap, above their cushion, into their
own asset account.

- Rotating the key with `update_config` stops new attestations at once. What was already added stays in `pending`
  until the user lowers it (`lower_pending`, down to 0) or exits.
- A user's pause stops attestations for them; after a resume, a return, a newly enabled token or rule or a larger
  change multiplier, only transfers from that moment count (`attestable_from`, never lowered).
- The 7-day window bounds which transfers can be claimed, not how many.
- The kill switch stops the sweeps that would spend `pending`; it does not stop `attest`.
- **Accepted residual:** a transfer counts once while its record exists. Once the record is closed, after its 7-day
  window, only the attestor's honesty about the event time stops the same transfer from counting again: a transfer has
  one block time, and the window refuses it at that time.

### The oracle

- Every price is a Pyth Pro update verified by the Pyth Pro program inside the sweep. The asset price (SPYX/USD,
  QQQX/USD) comes from the update Kamino Scope posts on mainnet, relayed by the crank; a USDT sweep carries a second,
  separate USDT/USD update the crank fetches with its own token. USDC counts at one dollar and carries no second
  update.
- The relay is a third-party dependency: if Kamino Scope stops posting, sweeps fail closed as the price goes stale; if
  its feed list grows, the update grows inside a sweep's byte budget. Pyth's terms for relaying another customer's
  updates and for posting our own on-chain are an open risk, carried by the relay; before a mainnet launch the crank
  switches to an entitled source of its own, an off-chain change. A suspension of the Pyth account would also stop
  the token-fetched USDT updates, so USDT sweeps stop too (fail closed) while USDC sweeps continue.
- An update is usable for 60 seconds by the feed's own timestamp, so a caller can pick among the last minute's prices.
  Confidence wider than 0.5% of the price is refused. The minimum output uses the conservative side of both
  confidence intervals, less 1% slippage.
- Freshness, confidence and slippage are the only price checks; there is no cross-index check. Trust rests on the
  signers Pyth's storage account lists, which Pyth's authority controls.

### The market calendar

The weekly engine buys only during a regular NYSE session of the calendar the admin loads into `Config`. Outside the
loaded span the market counts as closed. The calendar is an admin liveness power: a wrong, missing or expired calendar
delays or stops weekly buys, `pending` included, but never moves funds and never lets a weekly user buy on a closed
day. The daily engine does not read it. Operations alarm 90 days before the calendar runs out.

### Route trust

The sweep checks only the router's address and the outcome: every swap-authority token account the route can write
ends as it started, no new one appears, and the user receives at least the minimum. Any caller can therefore fill a
sweep anywhere between that minimum and the market, through its own pool or around a sandwich. At the $25 tier that
is about $0.25 a week per user, plus the confidence margin.

The router is fixed at `initialize`: it receives the swap authority's signature, so only a new deployment can change
it. A hostile route, or any venue a route calls, gets only that signature: it cannot pull another subscriber, update
or delete a plan, or keep, approve, reassign, reallocate or reconfigure a swap-authority token account. The crank's
signature never reaches a route either: the program passes a route's accounts without it, the crank's route builder
lets Jupiter name the swap authority as the route's payer (a venue that takes its payer as a signer gets the swap
authority, which holds no SOL), and it refuses a route that names the crank.

### User controls, exit and return

Every control needs the user's signature and touches only their own settings and subscriptions, and none is stopped
by the kill switch except the return, which takes enrollment's checks.

- `update_settings` changes the asset, engine, rules, cushions and goal, never the tier or the payment tokens.
- `set_user_paused` stops sweeps and attestations for the user.
- `lower_pending` only lowers `pending`.
- `change_tier` and `change_payment_tokens` end the dropped subscriptions at once and require live ones for what they
  add; they refuse any subscription but the user's own.
- `exit` ends every subscription at once, frees a beta seat, discards `pending` and clears the settings. A subscription
  the user already cancelled through Subscriptions is ended at once; one already closed or expired is skipped.
- `UserConfig` is never closed, so a return (`reactivate`, signed by the user and the sponsor) grants no new trial
  week, sweep day or week's cap. Its rent is a per-user cost.

Outside Laterite, the user can always cancel through Subscriptions or revoke the token approval directly; either stops
every pull.

### The kill switch

`set_paused` stops `enroll`, `reactivate` and `sweep`. It does not stop `attest`, `close_attestation`, any other user
control, the admin instructions or plan creation.
