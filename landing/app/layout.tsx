import type { Metadata, Viewport } from "next";
import { Archivo, Martian_Mono } from "next/font/google";
import "./globals.css";

// Archivo carries both voices: width 110-125 at weight 900 for display,
// width 100 for running text. The width axis must be requested explicitly.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
});

// Every amount, date, label and address is set in Martian Mono.
const martianMono = Martian_Mono({
  variable: "--font-martian-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Laterite · Get paid. Lay a brick.",
  description:
    "Every payday, a capped slice of your dollars becomes S&P 500. Automatically, from your own wallet.",
};

export const viewport: Viewport = {
  themeColor: "#1E1612",
};

// Direction contract. Kept in the emitted markup so the build can be audited
// against the decision that produced it.
const DIRECTION_CONTRACT = `<!--
THESIS: The headline is the wall. The words are laid like courses of brick and one real brick settles into the gap, carrying the whole mechanism. Refuses the category default of headline-left, phone-mockup-right.
OWN-WORLD: Lime ground #F4EEE2, soot #1E1612 type, terracotta #B8452E reserved for the brick, the primary action and the mark. Archivo at width 110, weight 900, uppercase, stacked with mortar-thin gaps. Martian Mono uppercase labels with leader arrows. Small radii, flat fields, one photographic object.
STORY: Visitor reads "get paid, lay a brick", sees $1,000 become a $25 brick of SPYx, believes the cap is the limit, and opens the app.
FIRST VIEWPORT: Soot nav band. Three full-width courses of type from the left margin: GET PAID. / LAY A + brick in the gap / BRICK. Mono labels and arrows annotate the brick. Bottom-left: one sentence, the terracotta button, three outlined chips. Bottom-right: next-section cue.
FORM: Letterpress forme. Candidate 6 of 7. Seed 9d8d3cbc.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${archivo.variable} ${martianMono.variable}`}>
      <body>
        <div hidden dangerouslySetInnerHTML={{ __html: DIRECTION_CONTRACT }} />
        {children}
      </body>
    </html>
  );
}
