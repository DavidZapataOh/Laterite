import type { Locale } from '@laterite/i18n';
import type messages from '@laterite/i18n/messages/en.json';

declare module 'next-intl' {
    interface AppConfig {
        Locale: Locale;
        Messages: Pick<typeof messages, 'landing'>;
    }
}
