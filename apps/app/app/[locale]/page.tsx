import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { routing } from '@laterite/i18n/routing';
import { Shell } from '@/components/shell';

export default async function Home({ params }: PageProps<'/[locale]'>) {
    const { locale } = await params;
    if (hasLocale(routing.locales, locale)) setRequestLocale(locale);
    return <Shell />;
}
