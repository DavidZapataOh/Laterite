import type { Metadata, Viewport } from 'next';
import { fontVariables } from '@laterite/ui/fonts';
import './globals.css';

export const metadata: Metadata = {
    title: 'Laterite · Get paid. Lay a brick.',
    description: 'Every payday, a capped slice of your dollars becomes S&P 500. Automatically, from your own wallet.',
};

export const viewport: Viewport = {
    themeColor: '#1E1612',
};

// Direction contract. Kept in the emitted markup so the build can be audited
// against the decision that produced it.
const DIRECTION_CONTRACT = `<!--
THESIS: The page lays a wall. The hero's headline is set like courses of brick with one real brick settling into the gap; below it, flat bands of colour each hold one idea and one large visual, while a spine of 52 brick ends fills as the visitor reads. Refuses the category default of headline-left, phone-mockup-right, and of feature-card grids.
OWN-WORLD: Lime #F4EEE2, soot #1E1612, terracotta #B8452E, blush #F2D6C6, used as whole fields or as objects, never as gradients. Archivo on its width axis, weight 900, for display; Martian Mono for every amount, date and label. The brick is the only photographic material. Seals are drawn in code. Small radii, hard edges, no shadows except a control's solid bottom edge.
STORY: Get paid, lay a brick. You set the cap. It runs itself. It stays yours. One year, 52 bricks. What it cannot do. What it is built on. Hardens with time. Open the app.
FIRST VIEWPORT: Soot nav band. Three full-width courses of type: GET PAID. / LAY A + brick in the gap / BRICK. Mono labels and arrows annotate the brick. Below: one sentence, the terracotta button, three outlined chips, and a cue to the first band.
FORM: Hero, letterpress forme, candidate 6 of 7, seed 9d8d3cbc. Body, bands of colour, candidate 6 of 7, seed 6584684c.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->`;

export default function RootLayout({ children }: LayoutProps<'/'>) {
    return (
        <html lang="en" className={fontVariables}>
            <body>
                <div hidden dangerouslySetInnerHTML={{ __html: DIRECTION_CONTRACT }} />
                {children}
            </body>
        </html>
    );
}
