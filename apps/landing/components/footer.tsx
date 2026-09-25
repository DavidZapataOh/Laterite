import Image from 'next/image';
import { getLocale, getTranslations } from 'next-intl/server';
import symbol from '@laterite/ui/brand/symbol-terracotta.svg';
import wordmark from '@laterite/ui/brand/wordmark-cream.svg';
import { getPathname } from '@/i18n/navigation';
import { site } from '@/lib/site';
import styles from './footer.module.css';

export async function Footer() {
    const t = await getTranslations('landing.footer');
    const other = (await getLocale()) === 'en' ? 'es-AR' : 'en';
    const links = site.links.filter(link => link.href);

    return (
        <footer className={`${styles.footer} on-dark`}>
            <div className={styles.logo}>
                <Image src={symbol} alt="" width={200} height={200} className={styles.symbol} unoptimized />
                <Image src={wordmark} alt="Laterite" width={454} height={74} className={styles.wordmark} unoptimized />
            </div>
            <div className={styles.aside}>
                <ul className={`${styles.links} mono`}>
                    {links.map(link => (
                        <li key={link.key}>
                            <a href={link.href} className={styles.link}>
                                {t(link.key)}
                            </a>
                        </li>
                    ))}
                    <li>
                        {/* a document request, so the proxy remembers the choice before it serves the page */}
                        <a
                            href={getPathname({ href: '/', locale: other, forcePrefix: true })}
                            hrefLang={other}
                            lang={other}
                            className={styles.link}
                        >
                            {t('language')}
                        </a>
                    </li>
                </ul>
                <p className={styles.small}>{t('legal')}</p>
            </div>
        </footer>
    );
}
