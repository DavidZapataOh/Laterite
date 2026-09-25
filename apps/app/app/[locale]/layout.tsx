import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { routing } from '@laterite/i18n/routing';
import { fontVariables } from '@laterite/ui/fonts';
import '../globals.css';

export function generateStaticParams() {
    return routing.locales.map(locale => ({ locale }));
}

export async function generateMetadata({ params }: LayoutProps<'/[locale]'>): Promise<Metadata> {
    const { locale } = await params;
    if (!hasLocale(routing.locales, locale)) return {};
    const t = await getTranslations({ locale, namespace: 'app.meta' });
    return { title: t('title'), description: t('description') };
}

export const viewport: Viewport = {
    themeColor: '#B8452E',
};

// Direction contract. Kept in the emitted markup so the build can be audited
// against the decision that produced it.
const DIRECTION_CONTRACT = `<!--
THESIS: One screen that reads like a stamped pay slip. A terracotta band carries the state's one figure in giant cream Archivo, the Seal rides the seam on a course of kiln bricks, quiet label and value rows follow on lime. Refuses the crypto dashboard of cards, charts, tabs and badges.
OWN-WORLD: Terracotta #B8452E field, kiln #7A2A1B course, lime #F4EEE2 ground, soot ink, sand rules. Archivo 900 wide for figures and values, Martian Mono for labels, chips and notes. Outlined chips, edged and outlined buttons, a round rubber stamp.
STORY: Connect a wallet, declare eligibility once, read the cap and its state, leave.
FIRST VIEWPORT: Bar: L symbol, DEVNET, EN / ES, wallet chip. Band: mono label, giant figure with its unit, one note, one cream action. Seal on the seam at the right. Rows below.
FORM: The terracotta band, surface round, seed 77e90a30.
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
                <NextIntlClientProvider>{children}</NextIntlClientProvider>
            </body>
        </html>
    );
}
