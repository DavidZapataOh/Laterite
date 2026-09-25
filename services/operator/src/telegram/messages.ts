import { defaultLocale, isLocale, type Locale } from '@laterite/i18n';
import en from '@laterite/i18n/messages/en.json';
import es from '@laterite/i18n/messages/es-AR.json';
import { createTranslator } from 'use-intl/core';

const MESSAGES = { en, 'es-AR': es } as const;

/** The bot's messages in `locale` (English for an unknown one), with dates in UTC, the program's days. */
export function botTranslator(locale: string) {
    const known: Locale = isLocale(locale) ? locale : defaultLocale;
    return createTranslator({ locale: known, messages: MESSAGES[known], namespace: 'bot', timeZone: 'UTC' });
}

/** The locale for a Telegram user's language: Spanish (Argentina) for any Spanish, else English. */
export const localeOf = (languageCode?: string): Locale => (languageCode?.startsWith('es') ? 'es-AR' : 'en');
