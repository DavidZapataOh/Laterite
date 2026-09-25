'use client';

import { useLocale, useTranslations } from 'next-intl';
import { chip } from '@laterite/ui/chip';
import { Link, usePathname } from '@/i18n/navigation';
import styles from './chips.module.css';

/** The network chip and the language switch, the first chips of every top bar. */
export function BarChips() {
    const t = useTranslations('app.bar');
    const locale = useLocale();
    const pathname = usePathname();
    const other = locale === 'en' ? 'es-AR' : 'en';
    return (
        <>
            <li className={`${chip} ${styles.chip} mono`}>{t('network')}</li>
            <li>
                <Link
                    href={pathname}
                    locale={other}
                    hrefLang={other}
                    aria-label={t('switchLanguage')}
                    className={`${chip} ${styles.chip} ${styles.link} mono`}
                >
                    {t('language')}
                </Link>
            </li>
        </>
    );
}
