import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { routing } from '@laterite/i18n/routing';
import { Footer } from '@/components/footer';
import { Hero } from '@/components/hero';
import { Nav } from '@/components/nav';
import { Story } from '@/components/story/story';

export default async function Home({ params }: PageProps<'/[locale]'>) {
    const { locale } = await params;
    if (hasLocale(routing.locales, locale)) setRequestLocale(locale);
    return (
        <>
            <Nav />
            <main id="main">
                <Hero />
                <Story />
            </main>
            <Footer />
        </>
    );
}
