import Image from 'next/image';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { button } from '@laterite/ui/button';
import symbol from '@laterite/ui/brand/symbol-terracotta.svg';
import wordmark from '@laterite/ui/brand/wordmark-cream.svg';
import { getPathname } from '@/i18n/navigation';
import { site } from '@/lib/site';
import styles from './nav.module.css';

export async function Nav() {
    const t = await getTranslations('landing.nav');

    return (
        <header className={`${styles.nav} on-dark`}>
            <a className="skip-link" href="#main">
                {t('skip')}
            </a>
            <Link
                href={getPathname({ href: '/', locale: await getLocale() })}
                className={styles.logo}
                aria-label={t('home')}
            >
                <Image src={symbol} alt="" width={200} height={200} className={styles.symbol} unoptimized />
                <Image src={wordmark} alt="" width={454} height={74} className={styles.wordmark} unoptimized />
            </Link>
            <nav className={styles.links} aria-label={t('label')}>
                <a href="#how-it-works" className={`${styles.link} mono`}>
                    {t('howItWorks')}
                </a>
                <a href={site.appUrl} className={`${button.flat} ${styles.launch}`}>
                    {t('launch')}
                </a>
            </nav>
        </header>
    );
}
