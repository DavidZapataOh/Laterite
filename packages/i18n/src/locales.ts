/** Every locale Laterite ships, in the order a language switch lists them. */
export const locales = ['en', 'es-AR'] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

/** True when `value` is one of Laterite's locales. */
export function isLocale(value: unknown): value is Locale {
    return locales.includes(value as Locale);
}
