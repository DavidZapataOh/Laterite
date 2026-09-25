---
version: 1
slug: "onboarding"
primary_target: "app/[locale]/page.tsx"
related_targets: []
---

# Surface brief: onboarding

**Scope and mode:** the connected-not-enrolled (and exited) state of the one-screen app, up to "Review and sign" (the permission screen and the signature are 04-03). Operate.

**Audience and job:** a wallet that just connected and declared eligibility, on a phone; set the rules in one screen, see exactly what a payday would invest, and move on to the one signature.

**Chosen direction:** "The payday preview". Approved comp `.impeccable/mocks/decision-onboarding/payday-preview.png`, seed 400a26a2, 2026-09-25 (surface round with three visualized structures; locking approves the comp). Build path: comp-led. Inherits the app's frame ("The terracotta band", `home.md`).

**Structure:** the band is a live preview: `IF YOU GET PAID $1,000` → the amount this week's rules would invest, in the giant figure, with a note stating the binding limit (the weekly cap, or the first week's $5 trial cap) and the Seal `PREVIEW` with the cap on the seam. Below on lime, one row per choice with outlined chips (selected chip solid soot): how you get paid (picks defaults only, not stored), weekly cap ($10 default, $25), income rule (10% of payments ≥ $50, on/off), change per payment (off default, 1x–3x), cushion ($20 per token), goal (label ≤ 32 UTF-8 bytes and amount), asset (SPYx default, QQQx), tokens (only those whose ATA the wallet has). Foot: one terracotta "Review and sign" brick button.

**Exactness rule:** the preview figure is computed with the same rules the program applies (`01-program/03`: income rule, change per payment rounding with the $0.50 minimum, the weekly cap, the 7-day $5 trial cap, cushions); never a number the program would not produce.

**States:** devnet faucet (no test tokens yet: one action funds USDC/USDT and creates the ATAs), prior delegate on a token account (explicit confirmation), exited wallet (same choices, reactivation shape, copy on carried-over trial and discarded "to invest"), closed (Config paused or user_count == max_users: before any signature), both locales.

**Risk to manage:** seven rows on a phone; each row one line, chips sized to thumbs; nothing below the fold except what scrolls naturally before the button.
