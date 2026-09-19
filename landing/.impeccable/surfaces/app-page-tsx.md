---
version: 1
slug: "app-page-tsx"
primary_target: "app/page.tsx"
related_targets: ["components/hero.tsx"]
---

# Surface brief: landing page, hero

**Scope and mode:** `/` first viewport. Persuade.

**Audience and job:** people paid in digital dollars, and hackathon judges. In seconds they must see that one payday becomes one capped brick of S&P 500, and open the app.

**Chosen direction:** "The headline is the wall" (letterpress forme). Approved comp: `.impeccable/mocks/decision/type-wall.png` (approved 2026-09-19, seed 9d8d3cbc).

**Memorable moment:** a real brick stamped $25 drops and settles into the gap in the second course of type; mono labels and leader arrows then draw in: +$1,000 USDC, $25 cap, 0.0412 SPYx.

**Design system read from the comp:** soot nav band; lime ground; three uppercase courses of Archivo (width 110, weight 900) at a 0.886em pitch, leaving 0.2em joints; terracotta only on the brick, the mark and the primary action; 2px soot outlined mono chips, 6px radius; button 8px radius with an 8px kiln bottom edge; no shadows except the brick's own baked contact shadow.

**Inventory and medium**

| Ingredient | Medium |
|---|---|
| Nav, logo | HTML + brand SVG |
| Type wall | HTML text, em-locked CSS |
| Brick stamped $25 | Raster with alpha (`public/hero/brick-25.png`), placeholder generated; final to be commissioned as 3D render / alpha video |
| Flow labels, leader arrows | HTML list + inline SVG |
| Sentence, CTA, chips, next cue | HTML/CSS |
| Settle, reveal, draw, pointer drift, lay-again | CSS keyframes + small client component |

**Responsive:** tall and 16:10 viewports stack sentence over actions; wide-and-short viewports put sentence, action and chips on one row so the wall keeps the width; under 720px the wall becomes four courses and the brick lands under it.

**Unresolved:** final brick asset; whether the cap on the brick becomes switchable ($10 / $25); sections below the hero.
