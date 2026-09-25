# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, on `@laterite/ui` (the design system the landing already uses), `@solana/kit` for wallets and transactions, `@laterite/client` for Laterite's accounts and instructions. This package is the product app; the landing is a separate surface.

## Users

People who get paid in digital dollars (USDC / USDT): freelancers, remote workers and crypto-native builders. They already hold their income on-chain, distrust custodians, and want long-term exposure to US stocks without moving money off-chain or remembering to invest. Most open the app on a phone, inside their wallet's browser (Phantom, Solflare, Backpack), right after the landing earned their trust; some use a desktop browser with a wallet extension.

Secondary audience: hackathon judges and ecosystem people trying the full flow on devnet.

## Product Purpose

Laterite is a non-custodial autopilot. The user signs one on-chain permission with a weekly cap. From then on, every time they get paid, a capped slice of their dollars is converted into tokenized S&P 500 (SPYx) and lands in their own wallet. No deposits, no reminders, no custody.

The app's job: connect a wallet, declare eligibility, set the rules and sign the one permission, then show, exactly and at a glance, what has been bought, what is waiting, what comes next and what the cap is, with pause and exit always one tap away.

Success: a returning user reads their numbers in seconds and leaves; nothing asks them to come back.

## Positioning

We do not sell access to the S&P 500; several apps do. We sell not having to do anything and not handing your money to anyone. The mechanism a neighboring product cannot truthfully copy: a capped, revocable on-chain permission (Solana Subscriptions & Allowances) with immutable destinations, so funds stay in the user's wallet until the moment of purchase and can only ever become stock in that same wallet.

Stance: anti-hype. Slow, solid, in plain sight.

## Operating Context

- Mobile first: the wallet's in-app browser on a phone is the primary context; desktop with an extension is secondary and gets a composed, centered layout, not a stretched phone.
- One screen: the connected home screen carries everything; history, settings, pause, exit and the Telegram link open as layers above it. No tab bar, no sections to navigate.
- The home screen leads with the numbers: position in SPYx (UI units), dollars invested, what is waiting to invest ("to invest"), the next buy, and the weekly cap. The Wall and the Seal support the numbers, never replace them.
- Availability depends on the tokenized-stock issuer's supported countries: blocked countries cannot proceed, and every user declares eligibility once, recorded with the wallet.
- Languages: English and Spanish (es-AR, voseo), switchable at any time.
- Devnet today: a faucet provides test USDC/USDT; nothing on the screen may suggest real money.

## Capabilities and Constraints

- Wallets: Phantom, Solflare and Backpack through Wallet Standard.
- Accepts USDC and USDT. One combined weekly cap ($10 default, $25). First week runs as a trial with a $5 cap.
- Sponsored onboarding: the user needs no SOL.
- Pause (reversible), lower "to invest", change the cap, change payment tokens, exit (revokes the permission; the account stays and can be reactivated).
- Prices verified on-chain (Pyth); swaps through Jupiter on mainnet, through Laterite's own devnet pools on devnet.
- Currently on devnet plus a mainnet fork. Not live on mainnet.
- Undecided: final app URL (working value: app.laterite.cash).

## Brand Commitments

- Name: Laterite (lowercase wordmark "laterite"). Laterite is the red earth that is cut into bricks and hardens with time.
- Binding assets: `packages/ui/brand/` (L-Bond symbol, outlined wordmark, lockups, seals, running-bond patterns).
- Fonts (pinned): Archivo on its width axis (display at weight 900, widths 110–125, mixed per line like a justified forme; text at widths 100–108) and Martian Mono (all amounts, receipts, addresses, program IDs, labels).
- Palette (pinned): terracotta #B8452E, lime #F4EEE2, soot #1E1612, plus ember #9C3822, kiln #7A2A1B, clay #E3A07F, blush #F2D6C6, chalk #FBF8F1, sand #E6DCCB, ash #6B5D54, char #3A2E28, and info #1F4E5A for external links. Light is the hero theme.
- Red is the brand, not loss: losses render in slate #5B5550 with a minus sign; danger is cold crimson #A3123A with an icon; gains are moss #4F6B3A.
- Forbidden: purple, neon lime, mint, bank blue, gradients, glow, dark-mode-with-gradient hero, stock photos of people, coins, candlestick charts, line charts of the index going up.
- Signature devices: the Seal (a brickmaker's stamp that marks every purchase and permission state) and the Wall (running-bond bricks, one per purchase).
- Shape logic: everything derives from the brick (2:1, 10px joint, running-bond offsets). Never a grid of identical cards.
- Motion: one idea, "lay a brick": elements drop and settle, no bounce.
- Voice: warm in address, exact in data. Always state the cap and what the app cannot do. No yield promises, no urgency.
- Vocabulary: Brick (one purchase), Course (one period), Cap (permission limit), First course (trial week), Laid (executed), The wall (history).
- Word budget for the app: labels over sentences; one short line of support per screen at most. Every number carries its unit.
- Reference craft level: bitstack-app.com (concision), qapital.com (real UI fragments), the landing itself (its world is this app's world). Anti-reference: crypto dashboards with dense tables, charts and badges.
- Taglines: "Hardens with time." / "Get paid. Lay a brick." / "Stay the course."

## Evidence on Hand

- Brand assets in `packages/ui/brand/`.
- No customers, press, usage numbers or testimonials exist. Future work must not fabricate any.
- Custom video, photography, 3D and motion graphics can be commissioned on request; request them with exact specs instead of substituting generic chrome.

## Product Principles

1. Numbers first, exact and in their units.
2. One screen; everything else is a layer that closes.
3. Say what Laterite cannot do before saying what it does.
4. Never promise or imply returns.
5. Never invent traction.

## Accessibility & Inclusion

WCAG AA contrast (terracotta on lime is 4.63:1). All motion has a settled, static alternative under `prefers-reduced-motion`. Color never carries meaning alone.
