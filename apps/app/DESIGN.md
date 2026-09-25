---
name: Laterite app
description: One screen that reads like a stamped pay slip. A terracotta band carries the state's figure; the Seal rides the seam.
colors:
  laterite-terracotta: "#b8452e"
  ember-hover: "#9c3822"
  kiln-course: "#7a2a1b"
  lime-ground: "#f4eee2"
  chalk-layer: "#fbf8f1"
  sand-rule: "#e6dccb"
  soot-ink: "#1e1612"
  danger-crimson: "#a3123a"
typography:
  figure:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "min(23.8u, 97u / ems)"
    fontWeight: 900
    lineHeight: 0.8
    letterSpacing: "-0.02em"
    fontVariation: "font-stretch 112%"
  value:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "min(11u, 60u / (chars × 0.8))"
    fontWeight: 900
    letterSpacing: "-0.01em"
    fontVariation: "font-stretch 125%"
  title:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "max(28px, 9.4u)"
    fontWeight: 900
    lineHeight: 0.95
    fontVariation: "font-stretch 125%"
  statement:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "max(15px, 4.3u)"
    fontWeight: 500
    lineHeight: 1.35
    fontVariation: "font-stretch 102%"
  label:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "max(12px, 3.9u)"
    fontWeight: 700
    letterSpacing: "0.14em"
  note:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "max(12px, 4.4u)"
    fontWeight: 500
    letterSpacing: "0.12em"
  receipt:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "max(13px, 3.7u)"
    lineHeight: 1.5
    letterSpacing: "0.02em"
rounded:
  chip: "6px"
  control: "8px"
  layer: "14px"
spacing:
  u: "min(100vw - 2 × gutter, 520px) / 100"
  gutter: "clamp(20px, 2.86vw, 55px)"
components:
  button-inverse:
    backgroundColor: "{colors.lime-ground}"
    textColor: "{colors.soot-ink}"
    rounded: "{rounded.control}"
    height: "max(48px, 14u)"
  button-primary:
    backgroundColor: "{colors.laterite-terracotta}"
    textColor: "{colors.lime-ground}"
    rounded: "{rounded.control}"
    height: "max(52px, 15u)"
  button-outline:
    textColor: "{colors.soot-ink}"
    rounded: "{rounded.chip}"
    height: "max(48px, 13.6u)"
  chip-on-band:
    textColor: "{colors.lime-ground}"
    rounded: "{rounded.chip}"
    height: "max(28px, 8.5u)"
  layer:
    backgroundColor: "{colors.chalk-layer}"
    textColor: "{colors.soot-ink}"
    rounded: "{rounded.layer}"
---

# Design System: Laterite app

## Overview

**Creative North Star: "The Stamped Pay Slip"**

The app is one screen. A terracotta band owns the top of the phone and carries the one figure of the current state in giant cream Archivo; a course of kiln bricks closes the band, and a round rubber stamp, the Seal, rides that seam with the permission's state. Below, on lime, label and value rows are separated by sand rules. Everything else is a layer that opens above this screen and closes. The approved comp, "The terracotta band" (`.impeccable/mocks/decision/terracotta-band.png`, seed 77e90a30), is the spatial contract; the direction contract is embedded in `app/[locale]/layout.tsx`.

The app inherits the landing's world and owns none of its primitives: tokens, fonts, the `primary`, `inverse` and `outline` buttons, the chip, the Seal (round and rectangular) and the brand marks live in `packages/ui`. This record describes how the app composes them. Screen geometry lives in `components/screen.module.css`; layers, the wallet menu and notices in `components/layers.module.css`; the band's chips in `components/chips.module.css`.

**Key Characteristics:**
- Numbers first: the band's figure is the state; every figure carries its unit.
- One screen, layers above it, no tabs and no navigation.
- The band is the brand, never an alert: problems are cold crimson with a drawn icon, below the band.
- Desktop centres the phone composition on full-bleed fields, never stretches it.
- Every size is a hundredth of the column, so the phone's proportions hold at every width.

## Colors

The landing's kiln palette (normative in `packages/ui/src/styles.css`), used as fields and objects.

### Primary
- **Laterite Terracotta** (`--laterite`): the band and the bar above it, one full-bleed field; the declaration's sign button.
- **Kiln** (`--kiln`): the course of bricks that closes the band, and the primary button's edge.
- **Ember** (`--ember`): hover of the band's chips and outline buttons on the band, and the sign button while the wallet asks.

### Neutral
- **Lime** (`--lime`): the ground under the band, every word on the band, the joints of the course, the Seal's paper.
- **Chalk** (`--chalk`): layers (the wallet layer, the declaration, the wallet menu) and notices.
- **Sand** (`--sand`): 2px rules between rows and between the declaration's statements.
- **Soot** (`--soot`): all ink on lime and chalk, the Seal's ink, layer outlines; 55% soot is the layers' backdrop.

### Tertiary
- **Cold Crimson** (`--danger`): a notice's outline, icon and words. Never the band, never terracotta.

### Named Rules
**The Band Is Not An Alert Rule.** The terracotta band states the state, including "unavailable" and "reading"; a failure is a crimson notice with a drawn icon in the rows, and the band stays as it was.

## Typography

Archivo (width axis) and Martian Mono from `packages/ui/fonts`, `font-synthesis: none`.

### Hierarchy
- **Figure** (Archivo 900, width 112, tabular, line-height 0.8): the band's one figure. It is fitted, never wrapped: its size is the smaller of 23.8u and 97u divided by its estimated advance in ems (figures and `$` 0.66em, punctuation 0.3em, capitals 0.82em, other letters 0.68em).
- **Value** (Archivo 900, width 125, uppercase): a row's value, at most 11u, fitted to 60u of the row by its length.
- **Title** (Archivo 900, width 125): a layer's heading.
- **Statement** (Archivo 500, width 102): the declaration's statements, the only running Archivo.
- **Label** (Martian Mono 700, uppercase, tracking 0.14em): the band's label; rows' labels at 500 and 0.16em.
- **Note** (Martian Mono 500, uppercase, tracking 0.12em): the one line under the figure.
- **Receipt** (Martian Mono 400, sentence case, tracking 0.02em): the one line of support a screen or layer may carry.

## Layout

- **The column.** Everything sits in one column, `min(100vw − 2 × gutter, 520px)` wide, centred. `--u` is a hundredth of it: 3.5px on a 390px phone, 5.2px on desktop. Fields (the bar, the band, the course) are full bleed; their content is the column.
- **The screen** is a column at least `100svh` tall: the bar (symbol left; chips right: DEVNET, EN / ES, the wallet), the band (sized by its content, as in the comp), the seam, then the body (rows, notices, a receipt line, and the foot pushed to the bottom).
- **The band** stacks the label (10.7u under the bar), the figure with its unit on the baseline, the note (balanced, never an orphan) and the band's one action, 11u above the seam. The lime body below takes the rest of the screen.
- **The seam** is a 0.8u lime joint, then a course 5.5u tall of kiln bricks 18.2u long with 0.8u lime joints, offset by 0.42 of a brick. The Seal (23u wide, rotated −8°) is centred on the joint at the column's right edge.
- **Rows** are at least 18.5u tall, label left, value right, a 2px sand rule between them.
- **Layers** are dialogs: a sheet from the foot of the phone (top corners 14px, no bottom border, safe-area padding), a centred card from 721px up.

## Elevation & Depth

Flat, as the landing. Depth is the primary and inverse buttons' solid bottom edge (from `packages/ui`). Layers are chalk on a 55% soot backdrop; the wallet menu is a chalk popover with a 2px soot outline. No shadows, no blur.

## Shapes

Chips and outline buttons 6px, buttons 8px, layers, the menu and notices 14px (notices 7px). The course's bricks are square-cornered bands of kiln cut by lime joints. The Seal is round: a 6-unit outer ring, a 2-unit inner ring, its label on both arcs, the main line in the middle, on lime paper.

## Components

### The bar
Terracotta field, `.on-dark`. The cream L symbol (decorative image with the name "Laterite") and a list of outlined lime chips (8.5u tall, mono 2.6u): the network (`DEVNET`, static), the language link (`EN / ES`, to the same page in the other locale, named "Leer en español" / "Read in English"), and, when connected, the wallet chip (first and last four characters in their own case: base58 is case-sensitive), which opens the wallet menu.

### The band's states
| State | Label | Figure | Note | Action | Seal |
|---|---|---|---|---|---|
| Not connected | Weekly cap | $10 / wk | or $25 · first week $5 | Connect {wallet} (one detected) or Connect a wallet | No permission, $0/WK |
| Connecting | Weekly cap | $10 / wk | or $25 · first week $5 | Approve in {wallet}, disabled | No permission |
| Reconnecting | Weekly cap | $10 / wk | or $25 · first week $5 | Reconnecting, disabled | No permission |
| Reading | Reading devnet | — | none | none | No permission |
| New or exited wallet (onboarding) | If you get paid $1,000 | what this week's rules would invest, e.g. $5.00, with a quiet THIS WEEK | the binding limit, then the following week: First week $5 · then $10/wk | none (the foot's Review and sign) | Preview, $N/WK of the chosen cap |
| Onboarding closed | Enrollment | Closed | Laterite's program is paused, or The beta is full | none | No permission, $0/WK |
| Active, paused | Weekly cap | $10 or $25 / wk | Active since, or Paused · enrolled, a date | none | Active or Paused, $N/WK |
| Unavailable | Your region | the country or region code | Not offered here | none | Unavailable, the country |

A pending connection never changes the screen: only the band's action says what it waits on, so the figure stays a number. Not connected, the rows say what Laterite cannot do: custody none, you sign once, exit any time. Unavailable, they name the issuer, the stock not offered and connecting closed, with one receipt line.

### Onboarding ("The payday preview")
The band is a live preview: a $1,000 payday received now, run through the program's own rules (the client's mirrors of `income_share` and `pull`, the NYSE session for the weekly engine), gives the figure, its unit set quiet (3.2u, weight 500) so the figure takes the line; the note names what binds it (the first week's $5, the cap, the cushion, or the rules), then what the following week buys (never above the cap), each clause kept whole so a break falls at the separator. Under the seam, one row per choice on one line, sand rules between: labels and chips in Martian Mono narrowed by its width axis (75%), the label on the left and its controls on the right: How you get paid (Stablecoins, I have savings: only defaults), Weekly cap ($10, $25 within the beta's cap), Schedule (Off, Daily, Weekly, and the amount a buy), Income rule (the rule's wording as a static chip, then On/Off), Change per payment (Off, 1x–3x), Cushion ($20 stays), Goal (name · amount), Asset (SPYx, QQQx), Tokens (the tokens whose account the wallet holds, and the faucet's outline button, which wraps, while one is missing; with none, the row's line says the faucet creates both accounts). Cushion and Goal are boxes spanning the control column (`$20 STAYS`, `HOUSE · $5,000` with the amount placeholder in the locale's digits); a long goal name scrolls in its own box so the amount stays whole. A choice's rule appears as a small line under its row only while it is on. A prior approval on a chosen token is a crimson notice with its own Replace it checkbox. An exited wallet reads one receipt line on what carries over. The foot is one terracotta brick, Review and sign, in mono as typed; clay and inert, with the reason in a line above it, until the choices can be signed.

Choices are `packages/ui`'s `Choice` (a native radio or checkbox inside an outlined chip, solid soot once chosen) at 40px or more; typed amounts are `packages/ui`'s `field` (an outlined box holding its inputs and units, as wide as what it holds).

### Buttons
- **Inverse** (the band's action): lime with a soot edge, full column width, 14u tall.
- **Primary** (the declaration's sign button): terracotta with a kiln edge, 15u tall; ember and inert while the wallet asks.
- **Outline** (wallet choices, disconnect, copy, try again, close): a 2px outline in the text's colour, mono uppercase at 0.16em; chalk on hover (ember on the band); presses 2px.

### Wallet layer
Title "Choose a wallet", one receipt line, then one outline button per supported wallet: a wallet this browser has connects; one it lacks is a link that opens this page inside that wallet's browser. Close at the foot. Opened only when the band's action cannot connect a single detected wallet.

### Declaration
A layer that cannot be dismissed: title, "Sign once to declare that:", three statements separated by sand rules, the receipt line "A signature, not a transaction", then the sign button and Disconnect. A declined signature or a refusal shows a crimson notice inside the layer.

### Wallet menu
A popover under the bar's right edge: the full address (mono, wraps anywhere), Copy address and Disconnect side by side.

### Notice
Chalk, a 2px cold crimson outline, 7px corners, a drawn circle-and-bar icon and the problem in words; a full-width outline recovery button (Try again) only where the screen has no other recovery (an unanswered read). A declined connection's recovery is the band's own action, so its notice has none. It sits above the rows and has the alert role.

### Motion
Layers rise 24px over 320ms on `--ease-lay` and appear still under reduced motion; buttons keep the landing's press. Nothing else moves: the screen loads into its state.

## Do's and Don'ts

### Do:
- **Do** put the state's one figure in the band, with its unit, fitted to the column.
- **Do** stamp the permission state on the Seal at the seam: No permission, Active, Paused, Revoked, Unavailable.
- **Do** open everything else as a layer above the one screen, and close it.
- **Do** size everything in `--u` so the phone composition holds on desktop.
- **Do** say a failure in crimson with a drawn icon and its recovery, under the band.
- **Do** take tokens, fonts, buttons, chips, the Seal and brand marks from `packages/ui`; add a missing primitive there, as its own entry or variant.

### Don't:
- **Don't** colour the band for an error, a warning or a block.
- **Don't** stretch the phone composition across a desktop, or give desktop a second layout.
- **Don't** add tabs, cards, charts or badges to the screen.
- **Don't** define a token, font, button, chip or seal style in the app.
- **Don't** show a number without its unit, or a figure that could read as a return.
