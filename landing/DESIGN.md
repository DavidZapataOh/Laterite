---
name: Laterite
description: Get paid. Lay a brick. A non-custodial autopilot, drawn as a letterpress forme built from one brick.
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
  label:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "clamp(10px, 0.94vw, 18px)"
    fontWeight: 400
    letterSpacing: "0.14em"
    fontFeature: "tnum"
rounded:
  chip: "6px"
  brick: "7px"
  control: "8px"
  card: "14px"
spacing:
  joint: "10px"
  gutter: "clamp(20px, 2.86vw, 55px)"
  nav-inset: "clamp(20px, 3.6vw, 70px)"
  nav-height: "clamp(64px, 6vw, 115px)"
components:
  nav-band:
    backgroundColor: "{colors.soot-ink}"
    textColor: "{colors.lime-ground}"
    height: "{spacing.nav-height}"
    padding: "0 clamp(20px, 3.6vw, 70px)"
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
  chip-outlined:
    textColor: "{colors.soot-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    height: "clamp(34px, 2.7vw, 52px)"
    padding: "0 clamp(12px, 1vw, 20px)"
  next-cue:
    textColor: "{colors.soot-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.brick}"
    padding: "10px 0"
  skip-link:
    backgroundColor: "{colors.lime-ground}"
    textColor: "{colors.soot-ink}"
    rounded: "{rounded.brick}"
    padding: "12px 18px"
---

# Design System: Laterite

## Overview

**Creative North Star: "The Letterpress Forme"**

Laterite is red earth cut into bricks that harden with time. The system treats the screen as a printer's forme: heavy uppercase type is locked up in courses like brick, the gaps between courses are mortar joints, and one real brick sits in the forme where a word would go. Everything else is annotation in a monospaced hand: amounts, labels, leader lines, outlined chips. The stance is anti-hype: slow, solid, in plain sight.

Only the nav and the hero are built. This document records the system those two establish so the rest of the page and the product app can be built from it. Tokens live in `app/globals.css`; the hero's geometry lives in `components/hero.module.css`. Where a rule below is pinned by `PRODUCT.md` but not yet exercised in code, it says so.

The field is flat and warm: lime ground, soot type, a soot nav band. Terracotta is scarce on purpose. There is one photographic object per view. There are no gradients, glows or drop shadows anywhere in the build.

**Key Characteristics:**
- Type is the structure. The headline is the wall; layout is measured in em of the course size.
- Three field colors (lime, soot, terracotta) carry the whole first viewport.
- Two voices: Archivo for words, Martian Mono for every amount, date, label and chip.
- Everything derives from the brick: 2:1 units, 10px joints, small radii, running-bond offsets.
- One motion grammar, "lay a brick": drop and settle, no bounce.
- Depth comes from thickness, never from light: a solid kiln edge under the primary action, a baked contact shadow under the brick.

## Colors

A kiln palette: one fired red, its darker and paler firings, and warm neutrals that never go pure gray. CSS variable names are given in code font; hex values are normative in the frontmatter.

### Primary
- **Laterite Terracotta** (`--laterite`): the mark, the primary action, the brick. Also the themed chrome: selection background, caret, accent color, scrollbar thumb, and the focus ring on light fields.
- **Ember** (`--ember`): hover state of any terracotta control. Nothing else.
- **Kiln** (`--kiln`): the solid bottom edge of the primary action, and the brick tone inside the terracotta running-bond pattern (at 55% opacity).

### Secondary
- **Clay** (`--clay`) and **Blush** (`--blush`): pale firings of the brand red for tints and quiet fills. Defined as tokens and exposed to Tailwind; not yet used by a component. Clay on lime is 1.89:1, so neither carries text.

### Tertiary (semantic; defined, not yet used by a component)
- **Moss** (`--gain`): gains. 5.20:1 on lime.
- **Slate** (`--loss`): losses, always with a minus sign. 6.35:1 on lime.
- **Cold Crimson** (`--danger`): danger and destructive states, always with an icon. 6.72:1 on lime.
- **Teal** (`--info`): informational states and external links. 7.92:1 on lime.

All four semantic tokens are mapped in the `@theme inline` block, so Tailwind utilities exist for them (`text-gain`, `bg-danger`, and so on) alongside `var(--gain)` etc.

### Neutral
- **Lime** (`--lime`): the ground. Page and `html` background, text on soot and on terracotta, the focus ring on dark fields. Named for slaked lime mortar; it is a warm cream, never a green.
- **Chalk** (`--chalk`): the lighter raised surface for cards and sheets on the lime ground. Not yet used.
- **Sand** (`--sand`): scrollbar track, and the brick tone in the cream running-bond pattern. 1.18:1 on lime: texture only.
- **Ash** (`--ash`): muted text and the Paused seal. 5.48:1 on lime.
- **Char** (`--char`): the brick tone in the soot running-bond pattern; raised surface on dark fields.
- **Soot** (`--soot`): all type on light fields, the nav band, 2px chip borders, leader lines, the browser theme color. 15.42:1 on lime.

### Contrast facts
- Terracotta on lime, and lime on terracotta: **4.63:1** (AA for text). This is the pair every terracotta button uses.
- Lime on ember (button hover): 6.05:1.
- Terracotta on soot: **3.33:1**. Passes for graphics (the symbol in the nav), fails for text.
- Terracotta on sand: 3.94:1. Fails for text.

### Named Rules
**The Three Places Rule.** Terracotta appears in exactly three kinds of place: the mark, the primary action, the brick (including Seals, which are the brick's stamp). It is never a heading color, a link color, a background wash or a chart series.

**The Red Is Not Loss Rule.** Red is the brand. A loss is slate with a minus sign. Danger is cold crimson with an icon. A gain is moss. Color never carries the meaning alone; the sign, the icon or the word does.

**The No Red Text On Soot Rule.** On the soot band, terracotta may be a shape (3.33:1), never words. Text on soot is lime.

## Typography

**Display Font:** Archivo, variable, with the width axis requested explicitly (`axes: ["wdth"]` in `app/layout.tsx`); fallback `system-ui, sans-serif`
**Body Font:** Archivo at width 100; same fallback
**Label/Mono Font:** Martian Mono; fallback `ui-monospace, monospace`

**Character:** One family does both jobs by changing width. Wide and black, it is masonry. At normal width it is a plain, warm grotesque. Martian Mono is the ledger: exact, tabular, uppercase, widely tracked. `font-synthesis: none` is set globally, so a weight or width the font does not have is never faked.

### Hierarchy
- **Display** (900, uppercase, tracking -0.015em, line-height 0.886): the type wall. Size is the `--fs` formula in the frontmatter: the smaller of a width fit (content width / 5.64) and a height fit (viewport height minus nav minus a reserved base, / 2.46), floored at 72px. Courses never wrap (`white-space: nowrap`). Width per course: **114 / 110 / 125** on desktop, **110** for all courses at 720px and below.
- **Title** (700, width 108, `clamp(1.125rem, 1.9vw, 2.3rem)`, line-height 1.14, tracking -0.01em, `text-wrap: balance`, max 23em): the hero sentence. In the wide-and-short layout it drops to `clamp(1rem, 1.42vw, 1.75rem)`, max 26em.
- **Action** (700, width 105): button labels, sentence case. Primary `clamp(1.0625rem, 1.56vw, 1.875rem)`; nav Launch `clamp(14px, 1.3vw, 25px)`.
- **Body** (400, width 100): inherited default from `html`. Text lives at widths 100 to 108: 100 for running copy, 105 for actions, 108 for the title sentence. No running text is built yet, so no size ramp or measure is recorded.
- **Label** (Martian Mono, uppercase, tracking 0.14em, tabular figures; the global `.mono` class): chips and next cue `clamp(10px, 0.94vw, 18px)`; nav link `clamp(11px, 0.95vw, 18px)`; flow steps weight 500 at `clamp(9px, 0.069em, 22px)` of the course size. Used for every amount, date, address, program ID, label and chip.

### Named Rules
**The Justified Forme Rule.** A stack of display courses is justified by mixing widths, not by changing size or tracking. The first course sets the measure; later courses are set narrower or wider (110 to 125) to reach their mark. Each course also carries its own negative left margin (-0.042em to -0.078em) so its first stem sits on the gutter.

**The Mortar Rule.** Course pitch is 0.886em. With Archivo's 0.686em cap height that leaves a 0.2em joint between courses. The joint is part of the design: annotation (the flow label row) is set inside it, and nothing else may close it.

**The Ticker Rule.** Mono labels are uppercase except tickers, which keep their own case (`SPYx`, via `text-transform: none`).

## Layout

**The em-locked wall.** `.wall` sets `font-size` to the course size, and everything inside it (brick position and width, flow label row, leader lines, course margins) is measured in em of that size. The brick therefore stays attached to the letterforms at every viewport: on desktop it sits at left 3.43em, top 0.76em, width 2.36em, in the gap after "LAY A". Leader paths are drawn in a viewBox whose units are hundredths of the course em. Build any future type-anchored object the same way.

**Gutter.** `--gutter: clamp(20px, 2.86vw, 55px)` is the page margin for all content. The nav band uses a slightly deeper inset, `clamp(20px, 3.6vw, 70px)`. The hero is a column: wall on top, base row pushed to the bottom with `margin-top: auto`, `min-height: calc(100svh - nav height)`, `overflow: clip`.

**Four layouts:**

| Layout | Condition | What changes |
|---|---|---|
| Tall (default) | wider than 720px, aspect ratio below 161:100 | Three courses. Base row stacks the sentence over the action and chips, next cue bottom-right. Height fit reserves `clamp(236px, 16.2vw, 311px)` for the base. |
| Wide and short | aspect ratio 161:100 or wider, and at least 721px wide | The wall keeps the full width. Sentence, action and chips share one row: sentence left, the action stacked over its three chips beside it. Reserve drops to `clamp(160px, 14.2vw, 272px)`. Chips shrink (height `clamp(30px, 2.3vw, 44px)`, tracking 0.1em), primary action `clamp(48px, 3.5vw, 66px)` tall. |
| Narrow | 720px and below | Four courses (GET / PAID. / LAY A / BRICK.), all at width 110, sized by width only (content width / 4.02). The brick leaves the gap and lands under the wall, right-aligned, 3.4em wide, overlapping the last course by 0.22em. The flow row sits under the brick at 10.5px; leader lines are hidden. Base becomes a left-aligned column, next cue right-aligned. At 560px and below the nav text link is hidden; Launch stays. |
| Narrow and short | 720px and below, and 760px tall or less | Same four courses. The brick shrinks to 2.7em and is pulled further over the wall (stage overlap -0.42em). The action and chips are ordered BEFORE the sentence (`order: -1`), the sentence follows 18px below, and the base padding tightens to 10px. At 390 x 664 the primary action spans y 523 to 575. |

**The First Viewport Rule.** The primary action is inside the first viewport, in every layout. In the tall and wide layouts the course size yields to viewport height so the wall and the base always fit. In the narrow layout the course size is width-only, so short phones get their own layout: the brick gives up size and the action moves ahead of the sentence. When space runs out, the sentence yields; the action never does.

**Rhythm.** Spacing between controls is fluid and proportional: `clamp(12px, 1.2vw, 24px)` between action and chips, `clamp(8px, 1.15vw, 22px)` between chips. Never a grid of identical cards; repeated units take running-bond offsets (half a unit plus half a joint per row).

## Elevation & Depth

Flat. No drop shadows, no blur, no glow, no tonal gradients. Surfaces are told apart by field color (soot band on lime ground) and by 2px soot outlines. Depth exists in exactly two places, and both are physical thickness rather than light:

### Shadow Vocabulary
- **Kiln edge** (`box-shadow: 0 var(--edge) 0 var(--kiln)`, `--edge: clamp(5px, 0.42vw, 8px)`, plus an equal `margin-bottom` so the edge occupies layout): the primary action stands proud like a brick. Hover sinks it 35% (`translateY(edge * 0.35)`, edge shortens to 65%); press sinks it fully (`translateY(edge)`, edge 0). Zero blur, zero x-offset, always straight down.
- **Baked contact shadow**: the soft shadow under the hero brick is part of the raster. Never add a CSS shadow or filter to it.

### Named Rules
**The Thickness Rule.** A thing may have a bottom edge if it is a brick you can press. Only the primary action qualifies. The nav Launch button is flat and moves 2px on press. Nothing floats.

## Shapes

Brick logic. The unit is a 2:1 brick with a 10px joint (`--joint`): in the brand assets a stretcher is 130 x 60, a header is 60 x 60, two headers plus a joint equal one stretcher, corner radius 7. The L-Bond symbol is four such bricks; the running-bond pattern offsets each row by half a unit.

- **Chip** (6px): outlined mono chips.
- **Brick** (7px, `--radius-brick`): the focus ring, skip link, logo and next-cue hit areas; the radius of every brick in the brand SVGs.
- **Control** (8px): buttons.
- **Card** (14px, `--radius-card`): containers. Used so far only as the hit-area radius of the hero brick.
- **Borders:** 2px solid soot for outlined elements. No hairlines, no 1px gray dividers.
- **Underlines:** links use offset 0.22em, thickness 0.08em. The nav link lays a 2px `currentColor` bar from the left on hover and focus: a `::after` element scaled on the x axis from `transform-origin: left`, like a course being laid. No gradient is used anywhere in the build.

## Components

### Navigation band
Soot band, lime content, `clamp(64px, 6vw, 115px)` tall, not sticky, carries the `.on-dark` class so focus rings flip to lime. Left: brand lockup. Right: one mono text link and the Launch button, gap `clamp(18px, 2.6vw, 50px)`. At 560px and below the text link is hidden.

### Brand lockup
Terracotta symbol plus cream wordmark from `public/brand/`, bottom-aligned, gap `clamp(10px, 1vw, 19px)`. Symbol height `clamp(34px, 3.55vw, 68px)`; wordmark height is half of it (`clamp(17px, 1.77vw, 34px)`) so the wordmark's x-height equals one course of the symbol. Both images are decorative (`alt=""`); the link carries `aria-label="Laterite, home"`. The wordmark is always lowercase.

### Buttons
- **Primary, "kiln edge"** (`Lay the first brick`): terracotta field, lime label, 8px radius, height `clamp(52px, 3.9vw, 75px)`, padding `0 clamp(26px, 3.1vw, 60px)`, kiln bottom edge per Elevation. Hover: ember, sinks 35%. Active: sinks fully. One per view.
- **Launch** (nav): same colors and radius, flat, height `clamp(40px, 3.2vw, 62px)`. Hover: ember. Active: `translateY(2px)`.
- All transitions: 320ms, `--ease-lay`.

### Chips
Outlined, never filled: 2px soot border, 6px radius, transparent field, mono label, height `clamp(34px, 2.7vw, 52px)`. Static guarantees, not controls; rendered as a list.

### Flow label row
An ordered list in mono set inside the mortar joint above the brick: `+$1,000 USDC`, arrow, `$25 cap`, arrow, `0.0412 SPYx`. Arrows are inline SVG strokes (1.6 on a 40 x 12 viewBox, square open head). The list has an `aria-label` that names it as an example. Amounts shown in marketing are always framed as an example.

### Leader lines
Three straight soot strokes (0.7 in a 241 x 36 em-hundredths viewBox, square caps) from the labels to the brick's top-left corner, top edge and top-right corner, each ending in a two-stroke open arrowhead and stopping just short of the object. Desktop only. Decorative (`aria-hidden`).

### Hero brick
The one photographic object: `public/hero/brick-25.png`, 1536 x 1024 raster with alpha, a red laterite brick stamped $25, carrying its own ~8 degree tilt and contact shadow. **Placeholder: to be replaced by a commissioned render at the same framing.** Behavior: drifts with the mouse pointer (up to 5px x, 4px y, 0.6 degrees, 600ms ease; mouse only), and a click lays it again by replaying the settle. Replay is a flourish, not a control, so the brick is not in the tab order and the image keeps real alt text. The stage is `pointer-events: none` except the brick itself, so the headline stays selectable.

### Next-section cue
Bottom-right mono link, `NN · Section name` plus a 2-stroke down arrow that moves 4px on hover. It names the next section; it is not a label over the current one.

### Skip link, focus, themed chrome
- **Skip link:** first element in the nav; lime field, soot 700 text, 7px radius; off-screen until focused, then `top: 12px` at the gutter.
- **Focus ring:** `3px solid` terracotta, offset 3px, 7px radius, on `:focus-visible` only. Inside `.on-dark` the ring is lime.
- **Selection:** terracotta field, lime text. **Caret and accent color:** terracotta. **Scrollbar:** thin, terracotta thumb on sand track.

### Motion: "lay a brick"
One grammar: things drop a short distance and settle. Easing `--ease-lay: cubic-bezier(0.2, 0.9, 0.25, 1)`; base duration `--dur-lay: 320ms` for all state transitions. No bounce, no spring, no fade-up-on-scroll.

Hero sequence (about 1.5s total):

| Element | Keyframes | Duration | Delay |
|---|---|---|---|
| Courses 1, 2, 3 | `lay`: from `translateY(-0.09em)` | 560ms | 0 / 70 / 140ms |
| Brick | `settle`: from `opacity 0, translateY(-0.95em) rotate(-10deg)`; opaque by 12%; at 62% it presses 0.012em and 0.6 degrees past rest, then eases to rest | 980ms | 320ms |
| Flow steps 1, 2, 3 | `reveal`: `clip-path` wipe from the left | 420ms | 750 / 900 / 1050ms |
| Leaders 1, 2, 3 | `draw`: `stroke-dashoffset` 60 to 0 | 380ms | 850 / 1000 / 1150ms |

**The Visible By Default Rule.** Every element's resting CSS is its final, visible state. Keyframes animate FROM hidden with `animation-fill-mode: both`; nothing depends on JavaScript or an observer to become visible.

**Reduced motion.** Under `prefers-reduced-motion: reduce` the four hero animations are removed and pointer drift is zeroed, so the page renders settled and static and the lay-again click does nothing. A global rule in `app/globals.css` also sets every transition duration to 0.01ms (and `scroll-behavior: auto`), so hover and press states change instantly: every motion has a still alternative.

### Signature devices shipped as assets (not yet implemented in code)
- **The Seal:** a brickmaker's stamp that marks every purchase and permission state. Five SVGs in `public/brand/`: `seal-laid`, `seal-capped`, `seal-trial` (terracotta), `seal-paused` (ash, dashed outer border), `seal-revoked` (soot). Anatomy: 9px outer rounded border, 3px inner border, symbol, mono overline, Archivo 900 at width 125 state word, mono detail line, the whole stamp rotated -3 degrees. State is carried by word and border style as well as color. The files use live text with a remote font import, which does not load when an SVG is used as an `<img>`; inline them or rebuild as a component. The values printed in them (course number, date, amount) are samples.
- **Running bond:** three tiling patterns, `running-bond-cream` (sand on lime), `running-bond-soot` (char on soot), `running-bond-terracotta` (kiln at 55% on terracotta). 140 x 140 tile of 130 x 60 bricks, radius 7, 10px joints, rows offset by half.
- **The Wall:** the history view, one running-bond brick per purchase. No asset or code yet beyond the pattern.
- **Marks:** symbol and wordmark in terracotta, cream and ink; horizontal and stacked lockups; `app-icon.svg`; `favicon.svg` (also `app/icon.svg`): lime symbol on a terracotta rounded square.

## Do's and Don'ts

### Do:
- **Do** keep terracotta to the mark, the primary action and the brick. Hover is ember; the edge is kiln.
- **Do** set every amount, date, address, program ID, label and chip in Martian Mono: uppercase, tracking 0.14em, tabular figures. Keep ticker case (`SPYx`).
- **Do** measure anything attached to display type in em of the course size, and justify stacked courses by mixing Archivo widths (110 to 125) at weight 900, pitch 0.886em, tracking -0.015em.
- **Do** keep the primary action inside the first viewport, one per view, with the kiln edge that compresses on press.
- **Do** state the cap wherever the mechanism is shown (`$25 cap`, `You set the cap`), and say what Laterite cannot do before what it does.
- **Do** frame every illustrative amount as an example.
- **Do** write within the word budget: hero 20 words (headline plus sentence currently use 19), section headline 4, section support 12, whole page 130, legal footer excluded.
- **Do** make the resting state the visible state, animate from hidden, and ship a settled static alternative under `prefers-reduced-motion`.
- **Do** pair every semantic color with a sign, icon or word. Loss is slate with a minus sign; danger is cold crimson with an icon; gain is moss.
- **Do** use the vocabulary: Brick (one purchase), Course (one period), Cap (permission limit), First course (trial week), Laid (executed), The wall (history).
- **Do** request produced imagery (render, photography, motion) with exact specs when a section needs an object.

### Don't:
- **Don't** use red for loss, error or decline. Red is the brand.
- **Don't** set terracotta text on soot (3.33:1) or on sand (3.94:1).
- **Don't** use purple, neon lime, mint or bank blue. Lime here means the cream mortar color only.
- **Don't** use gradients, glow, blur, drop shadows, or a dark hero with a gradient. Flat fields only.
- **Don't** show stock photos of people, coins, candlestick charts, or a line chart of the index going up.
- **Don't** lay out a grid of identical cards. Repeated units take brick proportions and running-bond offsets.
- **Don't** promise or imply returns: no yield figures, no projections, no urgency.
- **Don't** invent traction: no customer counts, logos, press, testimonials or usage numbers. None exist.
- **Don't** bounce, spring or overshoot upward. Things drop and settle.
- **Don't** let a display course wrap, close a mortar joint, or fake a weight or width (`font-synthesis: none`).
- **Don't** add a second photographic object to a view, or a CSS shadow to the brick.
- **Don't** put the hero brick, or any replay flourish, in the tab order.
- **Don't** capitalize the wordmark or recolor the marks outside terracotta, cream and ink.
