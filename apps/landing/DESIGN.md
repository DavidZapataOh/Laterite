---
name: Laterite
description: Get paid. Lay a brick. A non-custodial autopilot, drawn as a letterpress forme and a wall built from one brick.
colors:
  laterite-terracotta: "#b8452e"
  ember-hover: "#9c3822"
  kiln-edge: "#7a2a1b"
  clay-tint: "#e3a07f"
  blush-tint: "#f2d6c6"
  chalk-surface: "#fbf8f1"
  lime-ground: "#f4eee2"
  sand-track: "#e6dccb"
  ash-muted: "#6b5d54"
  char-course: "#3a2e28"
  soot-ink: "#1e1612"
  gain-moss: "#4f6b3a"
  loss-slate: "#5b5550"
  danger-crimson: "#a3123a"
  info-teal: "#1f4e5a"
typography:
  display:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "max(min(calc((100vw - 2 * var(--gutter)) / 5.64), calc((100svh - var(--nav-h) - clamp(236px, 16.2vw, 311px)) / 2.46)), 72px)"
    fontWeight: 900
    lineHeight: 0.886
    letterSpacing: "-0.015em"
    fontVariation: "font-stretch 110% base; courses 114% / 110% / 125%; all 110% at 720px and below"
  headline:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(2.8rem, 7.5vw, 8.8rem)"
    fontWeight: 900
    lineHeight: 0.92
    letterSpacing: "-0.028em"
    fontVariation: "font-stretch 125%"
  title:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(1.125rem, 1.9vw, 2.3rem)"
    fontWeight: 700
    lineHeight: 1.14
    letterSpacing: "-0.01em"
    fontVariation: "font-stretch 108%"
  action:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(1.0625rem, 1.56vw, 1.875rem)"
    fontWeight: 700
    fontVariation: "font-stretch 105%"
  body:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontWeight: 400
    fontVariation: "font-stretch 100%"
  figure:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "clamp(2.4rem, 7.4vw, 8.4rem)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.04em"
    fontFeature: "tnum"
  receipt:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "clamp(13px, 1.6vw, 26px)"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.02em"
    fontFeature: "tnum"
  label:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "clamp(10px, 0.94vw, 18px)"
    fontWeight: 400
    letterSpacing: "0.14em"
    fontFeature: "tnum"
rounded:
  masonry: "2px"
  chip: "6px"
  brick: "7px"
  control: "8px"
  card: "14px"
spacing:
  masonry-joint: "1.5px"
  joint: "10px"
  gutter: "clamp(20px, 2.86vw, 55px)"
  nav-height: "clamp(64px, 6vw, 115px)"
  band-pad-y: "clamp(64px, 7.4vw, 128px)"
  band-gap: "clamp(28px, 5vw, 96px)"
  spine-width: "clamp(56px, 6.5vw, 100px)"
components:
  nav-band:
    backgroundColor: "{colors.soot-ink}"
    textColor: "{colors.lime-ground}"
    height: "{spacing.nav-height}"
    padding: "0 clamp(20px, 2.86vw, 55px)"
  nav-link:
    textColor: "{colors.lime-ground}"
    typography: "{typography.label}"
    padding: "10px 2px"
  button-launch:
    backgroundColor: "{colors.laterite-terracotta}"
    textColor: "{colors.lime-ground}"
    rounded: "{rounded.control}"
    height: "clamp(40px, 3.2vw, 62px)"
    padding: "0 clamp(18px, 2vw, 38px)"
  button-launch-hover:
    backgroundColor: "{colors.ember-hover}"
  button-primary:
    backgroundColor: "{colors.laterite-terracotta}"
    textColor: "{colors.lime-ground}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    height: "clamp(52px, 3.9vw, 75px)"
    padding: "0 clamp(26px, 3.1vw, 60px)"
  button-primary-hover:
    backgroundColor: "{colors.ember-hover}"
  button-primary-on-terracotta:
    backgroundColor: "{colors.lime-ground}"
    textColor: "{colors.soot-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    height: "clamp(56px, 6vw, 96px)"
    padding: "0 clamp(30px, 5vw, 92px)"
  button-primary-on-terracotta-hover:
    backgroundColor: "{colors.chalk-surface}"
  chip-outlined:
    textColor: "{colors.soot-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    height: "clamp(34px, 2.7vw, 52px)"
    padding: "0 clamp(12px, 1vw, 20px)"
  chip-stack:
    textColor: "{colors.soot-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    height: "clamp(36px, 3.6vw, 62px)"
    padding: "0 clamp(14px, 1.4vw, 26px)"
  next-cue:
    textColor: "{colors.soot-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.brick}"
    padding: "10px 0"
  band-lime:
    backgroundColor: "{colors.lime-ground}"
    textColor: "{colors.soot-ink}"
    padding: "clamp(64px, 7.4vw, 128px) clamp(20px, 2.86vw, 55px)"
  band-terracotta:
    backgroundColor: "{colors.laterite-terracotta}"
    textColor: "{colors.lime-ground}"
    padding: "clamp(64px, 7.4vw, 128px) clamp(20px, 2.86vw, 55px)"
  band-soot:
    backgroundColor: "{colors.soot-ink}"
    textColor: "{colors.lime-ground}"
    padding: "clamp(64px, 7.4vw, 128px) clamp(20px, 2.86vw, 55px)"
  band-blush:
    backgroundColor: "{colors.blush-tint}"
    textColor: "{colors.soot-ink}"
    padding: "clamp(64px, 7.4vw, 128px) clamp(20px, 2.86vw, 55px)"
  card-fragment:
    backgroundColor: "{colors.chalk-surface}"
    textColor: "{colors.soot-ink}"
    rounded: "{rounded.card}"
    padding: "clamp(20px, 2vw, 34px) clamp(22px, 2.2vw, 38px) clamp(22px, 2.2vw, 38px)"
  option:
    backgroundColor: "{colors.chalk-surface}"
    textColor: "{colors.soot-ink}"
    rounded: "{rounded.chip}"
    height: "clamp(46px, 5vw, 84px)"
  option-hover:
    backgroundColor: "{colors.blush-tint}"
  option-selected:
    backgroundColor: "{colors.laterite-terracotta}"
    textColor: "{colors.lime-ground}"
  wall-brick:
    rounded: "{rounded.masonry}"
    padding: "{spacing.masonry-joint}"
  footer-band:
    backgroundColor: "{colors.soot-ink}"
    textColor: "{colors.lime-ground}"
    padding: "clamp(48px, 5.6vw, 100px) clamp(20px, 2.86vw, 55px)"
  skip-link:
    backgroundColor: "{colors.lime-ground}"
    textColor: "{colors.soot-ink}"
    rounded: "{rounded.brick}"
    padding: "12px 18px"
---

# Design System: Laterite

## Overview

**Creative North Star: "The Letterpress Forme"**

Laterite is red earth cut into bricks that harden with time. The system treats the screen as a printer's forme: heavy type is locked up in courses like brick, the gaps between courses are mortar joints, and one real brick sits in the hero where a word would go. Everything else is annotation in a monospaced hand: amounts, dates, labels, receipt lines, outlined chips, stamped seals. The stance is anti-hype: slow, solid, in plain sight.

The page is one scroll: a soot nav band, the type-wall hero, seven full-bleed bands of flat colour with a 52-brick spine running down their right edge, and a one-row soot footer. Each band holds one idea and one large visual: an interface fragment, a strip of bricks, a wall. This record describes what ships. Tokens live in `packages/ui/src/styles.css`; hero geometry in `components/hero.module.css`; the bands in `components/story/story.module.css`.

Fields are flat and warm. There are no gradients, glows, blurs or drop shadows anywhere in the build. The only photographic material is the brick. The direction contract embedded in `app/layout.tsx` says the same: colours are whole fields or objects, the brick is the only photographic material, seals are drawn in code.

**Key Characteristics:**
- Type is the structure. The hero headline is a wall measured in em of its course size; band headlines run at 7.5vw.
- Four field colours (lime, terracotta, soot, blush) in full-bleed bands; no two adjacent bands share a field.
- Two voices: Archivo for words, Martian Mono for every amount, date, label, chip, receipt line and card.
- Everything derives from the brick: running bond, tight joints, small radii, brick-end spine.
- One motion grammar, "lay a brick": drop and settle, no bounce. Scroll lays the bricks.
- Finished by default: the server renders the full wall, the final figure and every seal; nothing is hidden on first paint.
- Depth comes from thickness, never from light: a solid edge under the primary action, a contact shadow baked into the brick rasters.

## Colors

A kiln palette: one fired red, its darker and paler firings, and warm neutrals that never go pure gray. CSS variable names are given in code font; hex values are normative in the frontmatter.

### Primary
- **Laterite Terracotta** (`--laterite`): the mark, the primary action, the selected cap option, the cap Seal, and the field of two bands ("It runs itself", "Hardens with time"). Also the themed chrome: selection background, caret, accent color, scrollbar thumb, focus ring on light fields.
- **Ember** (`--ember`): hover state of a terracotta button. Nothing else.
- **Kiln** (`--kiln`): the solid bottom edge of the terracotta primary action.

### Secondary
- **Blush** (`--blush`): the field of the "What Laterite can't do" band, and the hover fill of an unselected cap option. Soot on blush is 12.90:1.
- **Clay** (`--clay`): defined and exposed to Tailwind; not used by any component. 1.89:1 on lime, so it never carries text.

### Tertiary (semantic; defined, not used on the landing page)
- **Moss** (`--gain`) 5.20:1 on lime, **Slate** (`--loss`) 6.35:1, **Cold Crimson** (`--danger`) 6.72:1, **Teal** (`--info`) 7.92:1. All four are mapped in the `@theme inline` block, so Tailwind utilities exist for them. They belong to the product app.

### Neutral
- **Lime** (`--lime`): the ground. Page background, three of the seven bands, the spine's ground, all text and line work on soot and on terracotta, the primary action's field on terracotta, the focus ring on dark fields. Named for slaked lime mortar; it is a warm cream, never a green.
- **Chalk** (`--chalk`): the raised surface of interface fragment cards, and the hover fill of the cream action. Soot on chalk is 16.80:1.
- **Sand** (`--sand`): scrollbar track and the 2px divider inside a card. Texture only (1.18:1 on lime).
- **Ash** (`--ash`): muted text, used for the empty vault row inside the wallet card. 5.97:1 on chalk, 5.48:1 on lime.
- **Char** (`--char`): defined; not used by a component.
- **Soot** (`--soot`): all type on light fields, the nav band, the wall band, the footer, 2px outlines, drawn icons including the can't-do crosses, the edge under the cream action, the browser theme color. 15.42:1 on lime.

### Contrast facts
- Lime on terracotta, and terracotta on lime: **4.63:1** (AA for text). Every word on a terracotta band or button relies on this pair.
- Lime on ember (button hover): 6.05:1. Terracotta on chalk: 5.04:1.
- Terracotta on soot: **3.33:1**; on blush: **3.87:1**; on sand: 3.94:1. Graphics only, never text.

### Named Rules
**The Object Or Field Rule.** Terracotta is either a whole object or a whole field, never words. As an object on a light field it is the mark, the primary action (and a selected option), the brick and its stamp. As a field it is a full-bleed band, at most two per page and never adjacent; on it everything is lime and the primary action inverts to cream with a soot edge. It is never a heading color, a link color, a partial wash or a chart series.

**The Negation In Ink Rule.** "No", "can't" and "never" are drawn in soot, like the can't-do crosses. Red is the brand, never a warning.

**The Red Is Not Loss Rule.** Red is the brand. A loss is slate with a minus sign. Danger is cold crimson with an icon. A gain is moss. Color never carries the meaning alone; the sign, the icon or the word does.

**The Lime On Dark Rule.** On soot and on terracotta, all text is lime, including the footer's legal line. Terracotta on soot may be a shape (the symbol, 3.33:1), never words. Dark bands carry the `.on-dark` class so focus rings flip to lime.

**The Alternating Field Rule.** Band order is lime, terracotta, lime, soot, blush, lime, terracotta, then the soot footer. Lime is the rest between statements; no two neighbours share a field.

## Typography

**Display Font:** Archivo, variable, with the width axis requested explicitly (`axes: ["wdth"]` in `app/layout.tsx`); fallback `system-ui, sans-serif`
**Body Font:** Archivo at width 100 to 108; same fallback
**Label/Mono Font:** Martian Mono; fallback `ui-monospace, monospace`

**Character:** One family does both jobs by changing width. Wide and black, it is masonry. At normal width it is a plain, warm grotesque. Martian Mono is the ledger: exact, tabular, and used far beyond labels. `font-synthesis: none` is set globally, so a weight or width the font does not have is never faked.

### Hierarchy
- **Display** (900, uppercase, tracking -0.015em, line-height 0.886): the hero type wall only. Size is the `--fs` formula in the frontmatter: the smaller of a width fit (content width / 5.64) and a height fit (viewport height minus nav minus a reserved base, / 2.46), floored at 72px. Courses never wrap. Width per course: **114 / 110 / 125** on desktop, **110** for all courses at 720px and below.
- **Headline** (900, width 125, sentence case with a full stop, `clamp(2.8rem, 7.5vw, 8.8rem)`, line-height 0.92, tracking -0.028em, `text-wrap: balance`): one per band, four words at most. It may wrap to two lines. Two bands set it smaller to fit a narrower column: can't-do `clamp(2.6rem, 5.4vw, 6.4rem)`, close `clamp(3rem, 7.2vw, 8.6rem)`.
- **Title** (700, width 108, `clamp(1.125rem, 1.9vw, 2.3rem)`, line-height 1.14, tracking -0.01em, balanced, max 23em): the hero sentence. In the wide-and-short layout it drops to `clamp(1rem, 1.42vw, 1.75rem)`, max 26em.
- **Action** (700, width 105, sentence case): button labels. Hero primary `clamp(1.0625rem, 1.56vw, 1.875rem)`; close primary `clamp(1.125rem, 2.6vw, 2.6rem)`; nav Launch `clamp(14px, 1.3vw, 25px)`.
- **Body** (400, width 100): the inherited default. The only running Archivo below the hero is the can't-do list: weight 500, width 102, `clamp(1.0625rem, 1.62vw, 1.85rem)`.
- **Figure** (Martian Mono 700, tabular, `clamp(2.4rem, 7.4vw, 8.4rem)`, tracking 0.04em, line-height 1.1): the wall's running total. Card figures use the same voice at tracking 0: cap figure `clamp(1.9rem, 4.9vw, 5.4rem)`, wallet row `clamp(1.8rem, 4.5vw, 5rem)`.
- **Receipt** (Martian Mono 400, sentence case, tracking 0.02em, line-height 1.5, tabular, balanced, `clamp(13px, 1.6vw, 26px)`): the one sentence a band is allowed, and the footer's legal line (`clamp(11px, 1.15vw, 18px)`). The cap sentence is set tight, `clamp(13px, 1.4vw, 23px)`, on one line above 720px.
- **Label** (Martian Mono, uppercase, tabular; the global `.mono` class at tracking 0.14em): chips and next cue `clamp(10px, 0.94vw, 18px)`; nav link `clamp(11px, 0.95vw, 18px)`; built-on chips `clamp(10px, 1.1vw, 18px)`; hero flow steps weight 500 at `clamp(9px, 0.069em, 22px)` of the course size. Labels inside bands open the tracking to 0.16 to 0.18em: card label `clamp(11px, 1.35vw, 22px)`, payday dates `clamp(10px, 1vw, 16px)`, figure note `clamp(11px, 1.6vw, 25px)`. The vault row is `clamp(13px, 1.9vw, 30px)` at 0.12em.

### Named Rules
**The Justified Forme Rule.** The hero's display courses are justified by mixing widths, not by changing size or tracking. The first course sets the measure; later courses are set narrower or wider (110 to 125) to reach their mark. Each course carries its own negative left margin (-0.042em to -0.078em) so its first stem sits on the gutter.

**The Mortar Rule.** Hero course pitch is 0.886em. With Archivo's 0.686em cap height that leaves a 0.2em joint between courses. The joint is part of the design: annotation (the flow label row) is set inside it, and nothing else may close it.

**The Receipt Line Rule.** Support copy under a band headline is one sentence, twelve words at most, set in mono sentence case like a line on a receipt. Bands never carry Archivo paragraphs.

**The Ticker Rule.** Mono labels are uppercase except tickers, which keep their own case (`SPYx`, via `text-transform: none` in the hero flow row).

## Layout

**Page.** Nav, then `main` (hero, story), then footer. The story is a two-column grid: the bands in `minmax(0, 1fr)` and the spine in a fixed right column (`--spine-w: clamp(56px, 6.5vw, 100px)`, 0 at 720px and below). The spine runs beside the seven bands only, never beside the hero or the footer.

**The One Left Edge Rule.** Nav, hero type, bands and footer all take their horizontal inset from `--gutter` (the bands' `--pad-x` is `var(--gutter)`), so the logo, the hero's first stem, every band headline and the footer lockup share one left edge: 20px on phones, 41px at 1440, 55px at 1920 and up. Never give a section its own inset.

**The Spanish forme.** `UN COBRO. / UN / LADRILLO.` ("One payday. One brick."; no accented capital, which the 0.2em joint could not hold). Measured ink per em: `UN COBRO.` at width 110 and `LADRILLO.` at width 120 both end 6.432em from the gutter, so they share the measure, and `UN` at 125 leaves the gap. The hero's custom properties carry the difference: `--measure` 6.29 (English 5.64: the same ratio to the first course's ink), `--brick-x` 4.096em and `--flow-x` 4.136em (the brick ends where the first course's ink does, as in English), every course pulled left 0.073em. At 720px and below the courses are `UN / COBRO. / UN / LADRILLO.` at width 110, sized by the last (`--measure-narrow` 6.11), and the stage is scaled by 6.11 / 4.02 so the brick and its labels keep the English size.

**The em-locked wall (hero).** `.wall` sets `font-size` to the course size, and everything inside it (brick position and width, flow label row, leader lines, course margins) is measured in em of that size. On desktop the brick sits at left 3.43em, top 0.76em, width 2.36em, in the gap after "LAY A". Leader paths are drawn in a viewBox whose units are hundredths of the course em. The hero is a column: wall on top, base row pushed down with `margin-top: auto`, `min-height: calc(100svh - nav height)`, `overflow: clip`.

**Four hero layouts:**

| Layout | Condition | What changes |
|---|---|---|
| Tall (default) | wider than 720px, aspect ratio below 161:100 | Three courses. Base row stacks the sentence over the action and chips, next cue bottom-right. Height fit reserves `clamp(236px, 16.2vw, 311px)` for the base. |
| Wide and short | aspect ratio 161:100 or wider, and at least 721px wide | Sentence, action and chips share one row: sentence left, the action stacked over its three chips beside it. Reserve drops to `clamp(160px, 14.2vw, 272px)`. Chips shrink (height `clamp(30px, 2.3vw, 44px)`, tracking 0.1em), primary action `clamp(48px, 3.5vw, 66px)` tall. |
| Narrow | 720px and below | Four courses (GET / PAID. / LAY A / BRICK.), all at width 110, sized by width only (content width / 4.02). The brick lands under the wall, right-aligned, 3.4em wide, overlapping the last course by 0.22em. The flow row sits under the brick at 10.5px; leader lines are hidden. Base becomes a left-aligned column, next cue right-aligned. At 560px and below the nav text link is hidden; Launch stays. |
| Narrow and short | 720px and below, and 760px tall or less | The brick shrinks to 2.7em and is pulled further over the wall (-0.42em). The action and chips are ordered BEFORE the sentence, the sentence follows 18px below, base padding tightens to 10px. |

**Bands.** Every band is a grid with `align-items: center`, padding `band-pad-y` by the gutter, `overflow: clip`. Default is two equal columns (copy left, visual right) with `band-gap`. Variants, in page order:

| # | Headline | Field | Grid | Visual |
|---|---|---|---|---|
| 1 | You set the cap. (anchor `#how-it-works`) | lime | 1fr / 1fr | Cap card with a stamped Seal |
| 2 | It runs itself. | terracotta | one column, copy right-aligned, gap `clamp(64px, 9vw, 150px)` | Payday strip |
| 3 | It stays yours. | lime | 1fr / 1fr | Wallet card |
| 4 | One year. 52 bricks. | soot | one column, no bottom padding | Figure, then the wall bleeding to both band edges |
| 5 | What Laterite can't do. | blush | 1.55fr / 1fr | Can't-do list |
| 6 | (none; labelled "Built on") | lime | one column, slim padding `clamp(30px, 3.2vw, 54px)` | Chip row |
| 7 | Hardens with time. | terracotta | 1.32fr / 1fr, padding `clamp(72px, 8vw, 140px)` | Cream action left, trial Seal right |

At 720px and below every band collapses to one column with a 36px gap, right-aligned copy returns to the left, and nowrap lines may wrap.

### Named Rules
**The First Viewport Rule.** The primary action is inside the first viewport, in every hero layout. In the tall and wide layouts the course size yields to viewport height. On short phones the brick gives up size and the action moves ahead of the sentence. When space runs out, the sentence yields; the action never does.

**The One Idea Rule.** A band holds one headline, at most one receipt line, and one large visual. Nothing else: no kicker, no section number, no second paragraph, no card grid.

**Rhythm.** Spacing is fluid and proportional (`clamp()` on vw), never a fixed step scale. Repeated units are bricks: they take running-bond offsets or stand on a baseline, never a grid of identical cards.

## Elevation & Depth

Flat. No drop shadows, no blur, no glow, no tonal gradients. Surfaces are told apart by field color and by 2px soot outlines. Depth exists in exactly two places, and both are physical thickness rather than light:

### Shadow Vocabulary
- **Kiln edge** (`box-shadow: 0 var(--edge) 0 var(--kiln)`, `--edge: clamp(5px, 0.42vw, 8px)`, plus an equal `margin-bottom` so the edge occupies layout): the terracotta primary action stands proud like a brick. Hover sinks it 35% (`translateY(edge * 0.35)`, edge shortens to 65%); press sinks it fully. Zero blur, zero x-offset, always straight down.
- **Soot edge** (`box-shadow: 0 var(--edge) 0 var(--soot)`): the same construction under the cream primary action on a terracotta band, same hover and press.
- **Baked contact shadow**: the soft shadows under the hero brick and the payday bricks are part of the rasters. Never add a CSS shadow to a brick.

The only CSS filters in the build are material, not light: `brightness(0.94)` and `brightness(1.05)` vary individual wall and spine bricks, and the Seal's SVG displacement filter roughens its ink.

### Named Rules
**The Thickness Rule.** A thing may have a bottom edge if it is a brick you can press. Only the primary action qualifies, in either colourway. The nav Launch button is flat and moves 2px on press. Cards are flat. Nothing floats.

## Shapes

Brick logic. In the brand assets a stretcher is 130 x 60, a header is 60 x 60, corner radius 7, joint 10 (`--joint`); the L-Bond symbol is four such bricks. On the page, laid masonry is tighter and sharper than the brand bricks, and interface gets softer as it gets larger:

- **Masonry** (2px wall bricks, 3px spine bricks): bricks laid in number. Joints are tight: each wall slot pads 1.5px, so neighbours sit 3px apart.
- **Chip** (6px): outlined mono chips, cap options, the dashed placeholder for a payday still ahead.
- **Brick** (7px, `--radius-brick`): the focus ring, skip link, logo and next-cue hit areas; every brick in the brand SVGs.
- **Control** (8px): buttons.
- **Card** (14px, `--radius-card`): interface fragment cards, and the hit area of the hero brick.
- **Seal**: 16 and 9 radii inside its own 120-unit viewBox; it scales as a drawing.
- **Borders:** 2px solid soot for outlined elements; 2px sand for the divider inside a card. No hairlines, no 1px gray dividers. The payday baseline is a 3px lime rule with 3 x 12px ticks.
- **Underlines:** links use offset 0.22em, thickness 0.08em. The nav link lays a 2px `currentColor` bar from the left on hover and focus (`scaleX` from `transform-origin: left`), like a course being laid. Footer links underline on hover.

### Named Rules
**The Dashed Means Not Yet Rule.** A 2px dashed outline marks a brick that has not been laid: the payday still ahead (lime on terracotta), the open slots in the wall's top course (lime at 70%), the unread bricks of the spine (soot at 55%). Solid is laid. Dashes are never decoration.

## Components

### Navigation band
Soot band, lime content, `clamp(64px, 6vw, 115px)` tall, inset by the gutter, not sticky, `.on-dark`. Left: brand lockup. Right: one mono text link (hidden at 560px and below) and the Launch button, gap `clamp(18px, 2.6vw, 50px)`.

### Brand lockup
Terracotta symbol plus cream wordmark from `packages/ui/brand/`, bottom-aligned. Wordmark height is half the symbol height so its x-height equals one course of the symbol. Nav: symbol `clamp(34px, 3.55vw, 68px)`, both images decorative, the link carries `aria-label="Laterite, home"`. Footer: symbol `clamp(44px, 4.6vw, 84px)`, not a link, the wordmark carries the alt text. The wordmark is always lowercase.

### Buttons
- **Primary, "kiln edge"** (`Lay the first brick`, hero): terracotta field, lime label, 8px radius, height `clamp(52px, 3.9vw, 75px)`, kiln bottom edge per Elevation. Hover: ember, sinks 35%. Active: sinks fully.
- **Primary on terracotta** (same label, closing band): cream field, soot label, soot edge, height `clamp(56px, 6vw, 96px)`, padding `0 clamp(30px, 5vw, 92px)`. Hover: chalk, sinks 35%. Active: sinks fully.
- **Launch** (nav): terracotta, flat, height `clamp(40px, 3.2vw, 62px)`. Hover: ember. Active: `translateY(2px)`.
- One primary action per view; the page has two, in the hero and at the close. All transitions: 320ms, `--ease-lay`.
- Shape, colour, edge and press live in `packages/ui/src/button.module.css` (`primary`, `inverse`, `flat`); each placement sets only its size.

### Chips
Outlined, never filled: 2px soot border, 6px radius, transparent field, mono label. Static facts, not controls; rendered as lists. Hero guarantees: height `clamp(34px, 2.7vw, 52px)`. **Built-on row:** five chips (`Solana Subscriptions & Allowances`, `Pyth`, `xStocks`, `Jupiter`, `Open source`), height `clamp(36px, 3.6vw, 62px)`, each `flex: 1 1 auto` so the row fills the band like one course; wraps and left-aligns on narrow screens. Names only, no logos.
Shape lives in `packages/ui/src/chip.module.css`; each placement sets only its size.

### Interface fragment cards
Real product UI, cut out and set on a band: chalk field, 2px soot border, 14px radius, everything inside in Martian Mono with tabular figures. No shadow, no device frame. Full column width.
- **Cap card:** uppercase label (`Your cap`), a large figure (`$25 / week`), and a two-option selector (`$10`, `$25`) built from native radio inputs in a `fieldset` with a screen-reader legend; the inputs are visually hidden and the labels are the buttons (2px soot border, 6px radius, height `clamp(46px, 5vw, 84px)`). The card opens on `$25`, not the product's `$10` default, on purpose: it matches the hero's example brick. Hover: blush. Selected: terracotta field and border, lime text. Keyboard focus rings the label (3px terracotta, offset 3px). Changing the value updates the band's receipt line (an `aria-live="polite"` region) and re-stamps the Seal, which overhangs the card's top-right corner at -8 degrees. Under a 2px sand divider, a definition list names both caps and who enforces each (`Laterite program · $25 in total`, `Solana Subscriptions · $25 per token`): ash labels, soot values, mono uppercase at `clamp(11px, 1.2vw, 20px)` tracked 0.12em (0.06em at 720px and below); a value that no longer fits beside its label moves under it, flush right.
- **Wallet card:** a definition list. The `SPYx` row is a large figure that counts from 0.4532 to 0.4944 over 1100ms (ease-out cubic) when the band enters; screen readers get the final value only. Under a 2px sand divider, the `Laterite vault` row reads `0.00` in ash, uppercase.

### Seal
A brickmaker's stamp, drawn in code (`packages/ui/src/seal.tsx`) so it takes live values. An SVG with a 6-unit outer rounded border (radius 16), a 2-unit inner border (radius 9), an optional mono overline (600, 11 units, tracking 0.16em) and a main line: Archivo 900 at width 112, 37 units, in a 300 x 120 viewBox, or, with `mono`, Martian Mono 600 at 21 units in a 470 x 120 viewBox for longer stamps. Colour is `currentColor`: terracotta on the cap card, lime on the closing band. An ink-roughness filter (`feTurbulence` fractal noise, base frequency 0.9, 2 octaves, into `feDisplacementMap` at scale 2.4) breaks every edge, because a dry rubber stamp never prints clean. The turbulence seed is derived from the stamp's text (character codes summed, mod 97), so no two stamps share the same roughness. Placement supplies the tilt (-8 and -6 degrees). Pass `decorative` when the same words are already on the page (it becomes `aria-hidden`); otherwise it is `role="img"` with the label and main line as its name. Shipped stamps: `$25 / WK` (live) and `TRIAL · 7 DAYS · CAP $5`.

**Stamp motion:** 420ms, `--ease-lay`, from `scale(1.24) rotate(-7deg)`, `animation-fill-mode: backwards`. Transform only: the seal is always rendered and only the press is animated. It plays when the band enters and again on every cap change (the wrapper is re-keyed). The keyframe is scale plus a twist on purpose; what is fixed is that it never touches opacity.

The five state seals in `packages/ui/brand/` (laid, capped, trial, paused, revoked) are an older, fuller anatomy (symbol, width-125 state word, -3 degree tilt, dashed border for paused). They are not used by the page and remain available assets.

### Payday strip
An ordered list labelled as an example: five paydays in equal columns (four at 720px and below; the first is dropped). A 3px lime baseline with a 12px tick per payday is painted first, under the bricks; mono dates hang below it. Three states:
- **Dropped** (laid paydays): the laid-brick raster at 92% of the column. Drops 46px into place over 640ms when the strip is half in view, staggered 110ms per brick.
- **Falling** (today): the same raster, tied to scroll. `--fall` is the band's scroll progress sliced from 0.34 to 0.66; the brick travels from `translateY(-56%) rotate(14deg)` to rest. Under reduced motion it holds still at `translateY(-30%) rotate(9deg)`, the pose of a brick about to land.
- **Ahead:** no raster; a 2px dashed lime outline, 2.15:1, 6px radius, 85% opacity.

### The wall
One year of paydays: 52 bricks in running bond on the soot band, bleeding to both band edges, with no bottom padding so the wall stands on the next band. Seven bricks per course above 720px (eight courses; the top one holds three bricks and four dashed slots), five per course below (eleven courses; two bricks and three slots). Both bonds are rendered and CSS shows one, so the layout never shifts after hydration. Offset courses shift left by half a brick and carry one extra half-brick, clipped at the edge, that shares its neighbour's number. Bricks are numbered from the bottom course up, left to right, the way a wall is built. Each brick is the face raster at 2.45:1 with a 2px radius inside a 1.5px slot padding; four turns (mirror x, mirror y, both, with brightness 0.94 or 1.05) keep repeats from reading as a pattern. The wall is `aria-hidden`.

Above it, the **figure** is 25 x bricks laid, formatted as currency, counting from `$0.00` to `$1,300.00` as the band scrolls (progress sliced 0.16 to 0.56). Screen readers get one fixed sentence instead of the running number. Under it the mono note **"Laid, not promised"**: the figure counts what was put in, never a return. Unlaid bricks sit 34px up at opacity 0 and land over 520ms.

### The spine
52 brick ends in a single column down the right edge of the bands, on lime, `aria-hidden`. Each slot is an equal share of the story's height, padded 16% at the sides; bricks have a 3px radius. Unread bricks are dashed outlines; a brick is laid (the face raster cropped to its middle, four turns) when the visitor's reading line, 74% down the viewport, passes it: 420ms drop from 10px up. It is the wall again at page scale: the page fills as it is read. Hidden at 720px and below.

### Can't-do list
Four short lines in Archivo 500 at width 102, each led by a drawn cross in soot: two strokes on a 20-unit viewBox, width 3.4, square caps, 0.95em. Icons are drawn as strokes in code, like the arrows; no icon font, no glyphs. The band sits fifth of seven on purpose: the cap line and the hero chips state the limits first, and this band collects them. Lines stay on one line above 720px.

### Hero pieces
- **Flow label row:** an ordered list in mono set inside the mortar joint above the brick: `+$1,000 USDC`, arrow, `$25 cap`, arrow, `0.0412 SPYx`. Arrows are inline SVG strokes (1.6 on a 40 x 12 viewBox, square open head). The list's `aria-label` names it as an example.
- **Leader lines:** three straight soot strokes (0.7 in a 241 x 36 em-hundredths viewBox, square caps) from the labels to the brick's top-left corner, top edge and top-right corner, each ending in a two-stroke open arrowhead just short of the object. Desktop only, decorative.
- **Hero brick:** drifts with the mouse pointer (up to 5px x, 4px y, 0.6 degrees, 600ms; mouse only), and a click lays it again by replaying the settle. Replay is a flourish, not a control, so the brick is not in the tab order and the image keeps real alt text. The stage is `pointer-events: none` except the brick, so the headline stays selectable.
- **Next-section cue:** bottom-right mono link: the next section's name (`The cap`) and a two-stroke down arrow that moves 4px on hover. No section number.

### Footer
One row on soot, `.on-dark`, padding `clamp(48px, 5.6vw, 100px)` by the gutter: lockup bottom-left; bottom-right, a row of mono links over one legal line in lime receipt mono, balanced (`Running on Solana devnet. Tokenized stocks are not available in every country.`). The links are Docs, GitHub and X from `lib/site.ts`, each rendered only when it has a real URL, then the language switch: the other locale's name in that language (`Español`, `English`), with `hreflang` and `lang`. The switch goes through the locale's prefix (`/es`, `/en`) as a document request, so the proxy stores the choice before it serves the page. Stacks left-aligned at 720px and below.

### Locales
English at `/`, Spanish (Argentina, voseo) at `/es`, from the `landing` namespace of `packages/i18n` (next-intl, statically rendered per locale). Only the server translates: the client bands receive their words as props, so the page ships no message catalogue and no i18n runtime. Amounts, shares and dates take the locale's digits (`$ 1.300,00`, `0,4944`, `05-sept`). The Spanish hero keeps the forme with its own words (below); every other band keeps its layout.

### Social card
`app/[locale]/opengraph-image.tsx` renders one 1200 x 630 PNG per locale at build (`next/og`, no external service), and `twitter-image.tsx` shares it: lime field, the terracotta symbol and ink wordmark, the hero's three courses at 144px in Archivo Expanded Black (`assets/fonts/archivo-expanded-black-latin.ttf`, the static width-125 weight-900 instance subset to Latin, OFL), and the hero brick in the second course's gap, ending where the first course ends. Its alt text is the headline in the locale. The proxy lets `/<locale>/opengraph-image/…` and `/<locale>/twitter-image/…` through untouched.

### Rasters
Three PNGs with alpha, and all three are **placeholders to be replaced by commissioned renders at the same framing**:
- `public/hero/brick-25.png` (1536 x 1024): a brick stamped $25, carrying its own ~8 degree tilt and contact shadow.
- `public/body/brick-laid.png` (1090 x 506): a brick stamped LAID with its contact shadow; the payday strip.
- `public/body/brick-face.png` (640 x 261): a flat brick face, used as a CSS background by the wall and, cropped, the spine; kept small because it repeats over a hundred times.

### Skip link, focus, themed chrome
- **Skip link:** first element in the nav; lime field, soot 700 text, 7px radius; off-screen until focused, then `top: 12px` at the gutter.
- **Focus ring:** `3px solid` terracotta, offset 3px, 7px radius, on `:focus-visible` only. Inside `.on-dark` the ring is lime.
- **Selection:** terracotta field, lime text. **Caret and accent color:** terracotta. **Scrollbar:** thin, terracotta thumb on sand track.

### Motion: "lay a brick"
One grammar: things drop a short distance and settle. Easing `--ease-lay: cubic-bezier(0.2, 0.9, 0.25, 1)`; base duration `--dur-lay: 320ms` for state transitions. No bounce, no spring, no fade-up-on-scroll.

Hero sequence (CSS only, about 1.5s):

| Element | Keyframes | Duration | Delay |
|---|---|---|---|
| Courses 1, 2, 3 | `lay`: from `translateY(-0.09em)` | 560ms | 0 / 70 / 140ms |
| Brick | `settle`: from `opacity 0, translateY(-0.95em) rotate(-10deg)`; opaque by 12%; at 62% it presses 0.012em and 0.6 degrees past rest | 980ms | 320ms |
| Flow steps | `reveal`: `clip-path` wipe from the left | 420ms | 750 / 900 / 1050ms |
| Leaders | `draw`: `stroke-dashoffset` 60 to 0 | 380ms | 850 / 1000 / 1150ms |

Below the hero, three small hooks in `packages/ui/src/` drive everything:
- **`useInView(threshold = 0.35)`**: reports true until hydration (via `useHydrated`), then false until the element enters, then true for good. Sets `data-in` for the one entrance on the page: copy and visual drop 14px over 620ms. Also triggers the payday drop (threshold 0.5), the stamp and the wallet count.
- **`useScrollProgress()` and `slice(progress, from, to)`**: progress of a band through the viewport, 0 to 1, measured at most once per frame; `slice` remaps a window of it onto 0 to 1 with an ease-out cubic. Drives the falling brick and the wall. Returns 1 at once under reduced motion.
- **`useHydrated()`**: false on the server and during hydration. Scroll-driven pieces render finished until it flips.

**The Finished By Default Rule.** The server renders the finished page, in state and in position: the wall full, the figure at `$1,300.00`, the spine full, every seal stamped, the wallet at its final balance, band copy and payday bricks settled (`data-in="true"`). Things are lifted away only after hydration, when the script asks, and then laid again as the visitor reaches them. In the hero, resting CSS is the visible state and keyframes animate FROM hidden with `animation-fill-mode: both`. Nothing depends on JavaScript or an observer to become visible.

**The Transform Only Rule.** Below the hero, entrances move; they never fade. The band entrance, the payday drop and the stamp animate `transform` alone, so content is readable before, during and without the animation. Opacity is used only for bricks the script has already lifted out of a finished wall or spine (and, in the hero, for the first 12% of the brick's own settle).

**The Still Alternative Rule.** Every motion has a still alternative, including hover and press. Under `prefers-reduced-motion: reduce`: hero animations and pointer drift are removed; band entrances, payday drops and stamps are off; the wall and spine render full and the figure final; the wallet shows its final value; the falling brick holds its tilted pose; and a global rule sets every transition to 0.01ms with `scroll-behavior: auto`, so hover and press change instantly.

### Brand assets shipped but not used by the page
Available, not retired. State seals (above); three running-bond tiles (`running-bond-cream`, `-soot`, `-terracotta`: 140 x 140 tile of 130 x 60 bricks, radius 7, 10px joints); symbol and wordmark in terracotta, cream and ink; horizontal and stacked lockups; `app-icon.svg`; `favicon.svg` (also `app/icon.svg`): lime symbol on a terracotta rounded square.

## Do's and Don'ts

### Do:
- **Do** treat terracotta as an object or a whole field: the mark, the primary action, the brick and its stamp, or a full-bleed band. Hover is ember; the edge is kiln.
- **Do** alternate band fields (lime, terracotta, lime, soot, blush, lime, terracotta) and set everything on soot or terracotta in lime.
- **Do** give each band one headline (four words, Archivo 900 at width 125, 7.5vw), at most one mono receipt line (twelve words), and one large visual.
- **Do** set every amount, date, address, label, chip, card and receipt line in Martian Mono with tabular figures. Labels are uppercase and tracked 0.14em or wider; keep ticker case (`SPYx`).
- **Do** measure anything attached to the hero type in em of the course size, and justify its courses by mixing Archivo widths (110 to 125) at weight 900, pitch 0.886em.
- **Do** show product UI as a flat fragment card: chalk, 2px soot border, 14px radius, mono, with native form controls underneath.
- **Do** draw seals with the Seal component, feed them live values, and mark them `decorative` when the words are already on the page.
- **Do** build repeated units as bricks: running bond, numbered bottom-up, 2 to 3px radius, 3px between neighbours, dashed when not yet laid.
- **Do** render the finished state on the server, position included, and lift things away only after hydration. Drive scroll pieces with `useScrollProgress` and `slice`, entrances with `useInView` and `transform`.
- **Do** ship a still alternative for every motion, hover and press included.
- **Do** keep the primary action inside the first viewport, with an edge that compresses on press; on terracotta it is cream with a soot edge.
- **Do** state the cap wherever the mechanism is shown, frame every illustrative amount as an example, and caption any total as laid, not promised.
- **Do** render a link only when it has a real destination.
- **Do** draw negation in soot: crosses, "can't", "never". Red is the brand, never a warning.
- **Do** inset every section by `--gutter` so nav, hero, bands and footer share one left edge.
- **Do** pair every semantic color with a sign, icon or word. Loss is slate with a minus sign; danger is cold crimson with an icon; gain is moss.
- **Do** use the vocabulary: Brick (one purchase), Course (one period), Cap (permission limit), First course (trial week), Laid (executed), The wall (history).
- **Do** replace the three placeholder rasters with commissioned renders at the same framing, and request any new produced imagery with exact specs.

### Don't:
- **Don't** use any photographic material other than the brick: no people, scenes, devices, coins or other objects. The hero keeps a single brick; below it the brick repeats only as masonry (strip, wall, spine).
- **Don't** set terracotta as text, as a link color, or as a partial wash. Never terracotta words on soot (3.33:1), blush (3.87:1) or sand (3.94:1).
- **Don't** use red for loss, error or decline. Red is the brand.
- **Don't** use purple, neon lime, mint or bank blue. Lime here means the cream mortar color only.
- **Don't** use gradients, glow, blur, drop shadows, or a CSS shadow on a brick. Flat fields only; depth is a solid bottom edge.
- **Don't** show candlestick charts or a line chart of the index going up, and don't present a figure that could be read as a return.
- **Don't** lay out a grid of identical cards, put a device frame around a fragment, or add kickers, eyebrows or section numbers to bands.
- **Don't** fade content in on scroll, hide anything until an observer fires, or let hydration shift the layout (render both variants and let CSS pick, as the wall does with its two bonds).
- **Don't** bounce, spring or overshoot upward. Things drop and settle.
- **Don't** let a hero course wrap, close a mortar joint, or fake a weight or width (`font-synthesis: none`).
- **Don't** put the hero brick, the wall, the spine or any replay flourish in the tab order or the accessibility tree.
- **Don't** use icon fonts or glyph icons; arrows and crosses are drawn strokes.
- **Don't** render placeholder links, invent traction (counts, logos, press, testimonials), or promise returns, yield or urgency.
- **Don't** capitalize the wordmark or recolor the marks outside terracotta, cream and ink.
