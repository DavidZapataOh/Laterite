import type { ButtonHTMLAttributes } from 'react';
import styles from './back.module.css';

/**
 * A step back to the screen before, as a quiet line with a drawn arrow: no box, since it is never the screen's action.
 * The placement sets the font. Pair it with `.mono`.
 */
export function Back({ className, children, ...button }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'>) {
    return (
        <button type="button" className={className ? `${styles.back} ${className}` : styles.back} {...button}>
            <svg className={styles.arrow} viewBox="0 0 16 12" aria-hidden>
                <path d="M15 6H2.2M6.6 1.4 2 6l4.6 4.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
            <span>{children}</span>
        </button>
    );
}
