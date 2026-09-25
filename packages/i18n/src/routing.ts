import { defineRouting } from 'next-intl/routing';

import { defaultLocale, locales } from './locales';

/** Locale routing for the Next.js apps: English at the root, Spanish (Argentina) under `/es`. */
export const routing = defineRouting({
    defaultLocale,
    localeCookie: { maxAge: 60 * 60 * 24 * 365 },
    localePrefix: { mode: 'as-needed', prefixes: { 'es-AR': '/es' } },
    locales,
});
