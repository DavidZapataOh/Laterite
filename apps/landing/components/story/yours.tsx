'use client';

import { useEffect, useState } from 'react';
import { useInView } from '@laterite/ui/use-in-view';
import { example, shares as sharesIn } from '@/lib/example';
import styles from './story.module.css';

const { before: BEFORE, after: AFTER } = example.wallet;

/** The wallet grows by one brick while the vault stays empty. Amounts are set in `locale`'s digits. */
export function Yours({
    locale,
    headline,
    line,
    balancesLabel,
    held: heldLabel,
    vault,
}: {
    locale: string;
    headline: string;
    line: string;
    balancesLabel: string;
    held: string;
    vault: string;
}) {
    const [ref, inView] = useInView<HTMLElement>();
    const [held, setHeld] = useState<number>(AFTER);
    const shares = sharesIn(locale);

    useEffect(() => {
        if (!inView || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        let frame = 0;
        const start = performance.now();
        const tick = (now: number) => {
            const t = Math.min(1, (now - start) / 1100);
            const eased = 1 - Math.pow(1 - t, 3);
            setHeld(BEFORE + (AFTER - BEFORE) * eased);
            if (t < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [inView]);

    return (
        <section ref={ref} className={`${styles.band} ${styles.lime}`} aria-labelledby="yours-title">
            <div className={`${styles.copy} ${styles.lays}`} data-in={inView}>
                <h2 id="yours-title" className={styles.headline}>
                    {headline}
                </h2>
                <p className={styles.line}>{line}</p>
            </div>

            <div className={`${styles.visual} ${styles.lays}`} data-in={inView}>
                <dl className={styles.card} aria-label={balancesLabel}>
                    <div className={styles.walletRow}>
                        <dt>SPYx</dt>
                        <dd aria-hidden="true">{shares.format(held)}</dd>
                        <dd className="sr-only">{heldLabel}</dd>
                    </div>
                    <div className={styles.vaultRow}>
                        <dt>{vault}</dt>
                        <dd>{new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(0)}</dd>
                    </div>
                </dl>
            </div>
        </section>
    );
}
