import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { routing } from '@laterite/i18n/routing';
import { fontVariables } from '@laterite/ui/fonts';
import { getPathname } from '@/i18n/navigation';
import { site } from '@/lib/site';
import '../globals.css';

export function generateStaticParams() {
    return routing.locales.map(locale => ({ locale }));
}

export async function generateMetadata({ params }: LayoutProps<'/[locale]'>): Promise<Metadata> {
    const { locale } = await params;
    if (!hasLocale(routing.locales, locale)) return {};
    const t = await getTranslations({ locale, namespace: 'landing.meta' });
    const title = t('title');
    const description = t('description');
    const url = getPathname({ href: '/', locale });
    return {
        metadataBase: new URL(site.url),
        title,
        description,
        alternates: {
            canonical: url,
            languages: {
                ...Object.fromEntries(routing.locales.map(other => [other, getPathname({ href: '/', locale: other })])),
                'x-default': '/',
            },
        },
        openGraph: {
            type: 'website',
            siteName: site.name,
            locale: locale.replace('-', '_').replace(/^en$/, 'en_US'),
            url,
            title,
            description,
        },
        twitter: { card: 'summary_large_image', site: site.x, creator: site.x, title, description },
    };
}

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

export default async function LocaleLayout({ children, params }: LayoutProps<'/[locale]'>) {
    const { locale } = await params;
    if (!hasLocale(routing.locales, locale)) notFound();
    setRequestLocale(locale);
    return (
        <html lang={locale} className={fontVariables}>
            <body>
                <div hidden dangerouslySetInnerHTML={{ __html: DIRECTION_CONTRACT }} />
                {children}
            </body>
        </html>
    );
}
