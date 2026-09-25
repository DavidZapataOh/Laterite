---
version: 1
slug: "permission"
primary_target: "app/[locale]/page.tsx"
related_targets: []
---

# Surface brief: the permission screen

**Scope and mode:** the `review` state of the one-screen app (after onboarding's "Review and sign"), up to the wallet's signature and the enrolled frame. Operate.

**Audience and job:** a wallet that just chose its rules, on a phone; read in seconds what the one signature can and cannot do, see that it costs them no SOL, and sign once.

**Chosen direction:** "The permission in numbered clauses". Approved comp `.impeccable/mocks/decision-permission/clauses.png`, seed 4e4c5b88, 2026-09-25 (surface round with three visualized structures; locking approves the comp). Build path: comp-led. Inherits the app's frame ("The terracotta band", `home.md`).

**Structure:** a back link to the rules inside the band; band label `ONE PERMISSION`, the giant weekly maximum (`$10 / WK MAX`), a note that no SOL is needed and Laterite pays the fees; the Seal `UNSIGNED` on the seam (it becomes the permission's real state once signed). Below on lime, five numbered clauses, one short line each: what it spends at most (the combined weekly cap, and each token's plan cap by the Subscriptions program), that it only buys the chosen asset into the user's own wallet, what it cannot do, pause/exit any time, how prices are checked (Pyth, on-chain, the bound). A quiet "What is SPYx?" line. One terracotta "Sign once" button. The simulation result is shown before the wallet opens; failures in plain words below the band, crimson with an icon.

**Copy rules:** the price clause matches the program: a minimum from fresh, on-chain-verified Pyth prices at the conservative end of their confidence intervals, less the slippage bound (0.55%); USDT at its own verified price, USDC at $1; no market-session claims, no guaranteed price, no partnership claims; any Pyth price shown carries the Pyth logo. Each clause stays one line at 390 px on Linux/Android metrics too (the app's rows rule: 6 px + 4% of text free off Linux).
