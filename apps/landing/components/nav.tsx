import Image from 'next/image';
import Link from 'next/link';
import { button } from '@laterite/ui/button';
import symbol from '@laterite/ui/brand/symbol-terracotta.svg';
import wordmark from '@laterite/ui/brand/wordmark-cream.svg';
import { site } from '@/lib/site';
import styles from './nav.module.css';

export function Nav() {
    return (
        <header className={`${styles.nav} on-dark`}>
            <a className="skip-link" href="#main">
                Skip to content
            </a>
            <Link href="/" className={styles.logo} aria-label="Laterite, home">
                <Image src={symbol} alt="" width={200} height={200} className={styles.symbol} unoptimized />
                <Image src={wordmark} alt="" width={454} height={74} className={styles.wordmark} unoptimized />
            </Link>
            <nav className={styles.links} aria-label="Primary">
                <a href="#how-it-works" className={`${styles.link} mono`}>
                    How it works
                </a>
                <a href={site.appUrl} className={`${button.flat} ${styles.launch}`}>
                    Launch app
                </a>
            </nav>
        </header>
    );
}
