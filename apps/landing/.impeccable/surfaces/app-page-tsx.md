---
version: 1
slug: "app-page-tsx"
primary_target: "app/page.tsx"
related_targets: ["components/hero.tsx","components/story/story.tsx"]
---

# Surface brief: landing page

**Scope and mode:** `/`, whole page. Persuade.

**Audience and job:** people paid in digital dollars, and hackathon judges. In seconds they must see that one payday becomes one capped brick of S&P 500, believe the cap is the limit, and open the app.

**Chosen directions**
- Hero: "The headline is the wall" (letterpress forme). Approved comp `.impeccable/mocks/decision/type-wall.png`, seed 9d8d3cbc, 2026-09-19.
- Body: "Bands of colour". Approved comp `.impeccable/mocks/decision-body/bands.png`, seed 6584684c, 2026-09-19.

**Story, top to bottom:** Get paid, lay a brick · You set the cap · It runs itself · It stays yours · One year, 52 bricks · What Laterite can't do · Built on · Hardens with time · footer.

**Memorable moments:** the hero brick settling into the gap in the type; the wall of 52 laying itself bottom-up with the scroll while the figure counts what was laid; the spine of 52 brick ends filling as the visitor reads.

**Inventory and medium**

| Ingredient | Medium |
|---|---|
| Type wall, bands, cards, chips, footer | HTML/CSS |
| Seals | SVG drawn in code, live values |
| Hero brick, LAID brick, brick face | Rasters with alpha in `public/hero` and `public/body`; placeholders, finals to be commissioned |
| Wall, spine | HTML bricks tiled from the face raster, scroll-driven |
| Motion | CSS keyframes and transitions driven by `useInView`, `useScrollProgress`, `useHydrated` |

**Reviews:** hero and body each passed an independent finish review (verdict ship on the scored fixes).

**Unresolved:** final rasters and alpha video; real URLs for Docs, GitHub and X; final app URL; Spanish locale.
