import { headers } from 'next/headers';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { routing } from '@laterite/i18n/routing';
import { BarChips } from '@/components/chips';
import { Receipt, Row, Rows, Screen } from '@/components/screen';
import { redirect } from '@/i18n/navigation';
import { isBlocked, requestRegion } from '@/lib/geo';

/** Where Laterite cannot be offered: the band says so and nothing proceeds. */
export default async function Unavailable({ params }: PageProps<'/[locale]/unavailable'>) {
    const { locale } = await params;
    const where = requestRegion(await headers());
    if (!hasLocale(routing.locales, locale)) return redirect({ href: '/', locale: routing.defaultLocale });
    if (!isBlocked(where)) return redirect({ href: '/', locale });
    const t = await getTranslations({ locale, namespace: 'app' });
    return (
        <Screen
            home={t('bar.home')}
            skip={t('skip')}
            chips={<BarChips />}
            band={{
                label: t('unavailable.label'),
                figure: where.region ?? where.country!,
                note: t('unavailable.note'),
            }}
            seal={{ label: t('seal.unavailable'), main: where.country! }}
        >
            <Rows>
                <Row label={t('unavailable.issuer')} value={t('unavailable.issuerValue')} />
                <Row label={t('unavailable.spyx')} value={t('unavailable.spyxValue')} />
                <Row label={t('unavailable.wallets')} value={t('unavailable.walletsValue')} />
            </Rows>
            <Receipt>{t('unavailable.why')}</Receipt>
        </Screen>
    );
}
