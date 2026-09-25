import { routing } from '@laterite/i18n/routing';
import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';

export default getRequestConfig(async ({ requestLocale }) => {
    const requested = await requestLocale;
    const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
    const { landing } = (await import(`@laterite/i18n/messages/${locale}.json`)).default;
    return { locale, messages: { landing } };
});
