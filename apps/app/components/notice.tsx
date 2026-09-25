import type { ReactNode } from 'react';
import styles from './layers.module.css';

/** A problem and its recovery, in cold crimson with a drawn icon: never the brand's red. */
export function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
    return (
        <div role="alert" className={styles.notice}>
            <svg className={styles.noticeIcon} viewBox="0 0 20 20" aria-hidden>
                <circle cx="10" cy="10" r="8.3" fill="none" stroke="currentColor" strokeWidth="2.4" />
                <path d="M10 5.4v5.8M10 13.6v1" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" />
            </svg>
            <p className={styles.noticeText}>{children}</p>
            {action}
        </div>
    );
}
