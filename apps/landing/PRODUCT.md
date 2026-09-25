# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4. This package is the marketing landing page; the product app is a separate surface.

## Users

People who get paid in digital dollars (USDC / USDT): freelancers, remote workers and crypto-native builders. They already hold their income on-chain, distrust custodians, and want long-term exposure to US stocks without moving money off-chain or remembering to invest. Technical level ranges from "uses a wallet daily" to Solana developer. The most skeptical of them know that a token approval is a risk and read every permission before signing.

Secondary audience for this landing page: hackathon judges and ecosystem people evaluating whether this could be a real product people use.

## Product Purpose

Laterite is a non-custodial autopilot. The user signs one on-chain permission with a weekly cap. From then on, every time they get paid in USDC or USDT, the income rule sets aside 10% of the payment (from $50), and Laterite converts it into tokenized S&P 500 (SPYx) that lands in their own wallet, within the weekly cap; what exceeds the cap waits for later weeks. The income rule is the default for people paid in stablecoins; someone investing savings starts on a daily schedule instead, and a weekly schedule and change per payment are the other rules. No deposits, no reminders, no custody.

Success: a visitor understands the mechanism in seconds, believes it cannot take more than the cap, and opens the app.

## Positioning

We do not sell access to the S&P 500; several apps do. We sell not having to do anything and not handing your money to anyone. The mechanism a neighboring product cannot truthfully copy: a revocable on-chain permission with two caps and immutable destinations, so funds stay in the user's wallet until the moment of purchase and can only ever become stock in that same wallet. Laterite's own program never invests more than the chosen weekly amount in total; the Solana Foundation's Subscriptions & Allowances program caps each enabled token at that amount. The combined cap is Laterite's program, never the Foundation's.

Stance: anti-hype. Slow, solid, in plain sight.

## Operating Context

- Primary action on the landing page: open the app (`Lay the first brick`). No waitlist.
- The visitor will be asked to sign a spending permission in the app, so the landing page must earn trust before that moment.
- Availability depends on the tokenized-stock issuer's supported countries; the page must state this.
- Languages: English at `/`, Spanish (Argentina, voseo) at `/es`; the footer switches between them.
- Links: the app (`https://app.laterite.cash`), the code (`https://github.com/DavidZapataOh/Laterite`), its docs (`docs/` in that repository) and X (`@lateritecash`).

## Capabilities and Constraints

- Accepts USDC and USDT. One weekly cap ($10 default, $25), enforced twice: Laterite's program invests at most that much per week across both tokens, and each enabled token's Subscriptions plan allows at most that much per week. The page's cap card names both, with who enforces each.
- Amounts: the income rule takes 10% of each incoming payment of $50 or more; a daily schedule buys once a day; a weekly schedule buys once a week during US market hours; change per payment rounds each payment the user makes up to the next dollar, $0.50 at least, times 1 to 3. Nothing is invested at once past the week's cap: the rest waits for later weeks. No copy promises a buy on a given day or every week without exception.
- Sponsored onboarding and controls: the user needs no SOL.
- First week runs as a trial with a $5 cap.
- Pause and exit from the main screen. Pausing buys nothing until the user resumes and keeps what waits to be invested. Exit (the page's "Revoke in one tap") is one signature, needs no SOL, ends every Laterite permission at once and works even while Laterite's kill switch is set; it discards what waits to be invested, the account stays (marked exited), and coming back starts no new trial week.
- Prices verified on-chain (Pyth): the asset's price is Pyth data relayed from updates another protocol posts on-chain, and a USDT purchase is also bounded by USDT's own verified price. Every purchase must return at least what the verified prices are worth at the conservative edge of their confidence, less 0.55% slippage, or it reverts, so a manipulated pool cannot fill it; there is no guaranteed price. No partnership with Pyth or Kamino exists; the Pyth name only says where prices are verified.
- Swaps route through Jupiter on mainnet and the mainnet fork. On devnet they route through Laterite's own deployment of open-source DEX code (Raydium's CP-Swap, Apache-2.0), never presented as Raydium's or any third party's venue.
- Audits: the Subscriptions & Allowances program is audited. Laterite's own program has an internal review with fuzzing, not an audit; no copy calls it audited.
- Currently on devnet plus a mainnet fork. Not live on mainnet.
- Undecided: final domains (working values: laterite.cash for this page, app.laterite.cash for the app).

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
- Word budget for marketing surfaces, in every locale: hero 20 words (headline and sentence), section headline 4, section support 12, whole page 130 (legal footer, accessible names and the example fragments excluded). `packages/i18n/test/landing.test.ts` checks it.
- Reference craft level: acorns.com (scroll as one visual narrative, produced imagery), bitstack-app.com (concision), qapital.com (floating real UI fragments). Anti-reference: text-heavy pages with generic graphics and no narrative.
- Taglines: "Hardens with time." / "Get paid. Lay a brick." / "Stay the course."

## Evidence on Hand

- Brand assets in `packages/ui/brand/`.
- No customers, press, usage numbers or testimonials exist. Future work must not fabricate any.
- Custom video, photography, 3D and motion graphics can be commissioned on request; request them with exact specs instead of substituting generic chrome.

## Product Principles

1. Show the mechanism; do not describe it.
2. Every word costs a million dollars.
3. Say what Laterite cannot do before saying what it does.
4. Never promise or imply returns.
5. Never invent traction.

## Accessibility & Inclusion

WCAG AA contrast (terracotta on lime is 4.63:1). All motion has a settled, static alternative under `prefers-reduced-motion`. Color never carries meaning alone.
