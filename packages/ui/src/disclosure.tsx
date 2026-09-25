import type { ReactNode } from 'react';
import styles from './disclosure.module.css';

/**
 * A line that opens what it summarizes in place: a native `<details>`, so the keyboard, find-in-page and screen
 * readers work as the platform's own. The chevron is drawn and turns down once open. The placement sets the fonts.
 */
export function Disclosure({
    summary,
    children,
    className,
}: {
    summary: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        <details className={className ? `${styles.disclosure} ${className}` : styles.disclosure}>
            <summary className={styles.summary}>
                <span>{summary}</span>
                <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden>
                    <path d="M4 1.5 8.5 6 4 10.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                </svg>
            </summary>
            <div className={styles.body}>{children}</div>
        </details>
    );
}
