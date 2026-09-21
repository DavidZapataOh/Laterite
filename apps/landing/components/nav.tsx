import Image from 'next/image';
import Link from 'next/link';
import { site } from '@/lib/site';
import styles from './nav.module.css';

export function Nav() {
    return (
        <header className={`${styles.nav} on-dark`}>
            <a className="skip-link" href="#main">
                Skip to content
            </a>
            <Link href="/" className={styles.logo} aria-label="Laterite, home">
                <Image
                    src="/brand/symbol-terracotta.svg"
                    alt=""
                    width={200}
                    height={200}
                    className={styles.symbol}
                    unoptimized
                />
                <Image
                    src="/brand/wordmark-cream.svg"
                    alt=""
                    width={454}
                    height={74}
                    className={styles.wordmark}
                    unoptimized
                />
            </Link>
            <nav className={styles.links} aria-label="Primary">
                <a href="#how-it-works" className={`${styles.link} mono`}>
                    How it works
                </a>
                <a href={site.appUrl} className={styles.launch}>
                    Launch app
                </a>
            </nav>
        </header>
    );
}
