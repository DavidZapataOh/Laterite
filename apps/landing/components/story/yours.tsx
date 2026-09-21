'use client';

import { useEffect, useState } from 'react';
import { useInView } from '@/lib/use-in-view';
import styles from './story.module.css';

const BEFORE = 0.4532;
const AFTER = 0.4944; // one more brick: +0.0412

/** The wallet grows by one brick while the vault stays empty. */
export function Yours() {
    const [ref, inView] = useInView<HTMLElement>();
    const [held, setHeld] = useState(AFTER);

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
                    It stays yours.
                </h2>
                <p className={styles.line}>Your stocks land in your wallet. Never ours.</p>
            </div>

            <div className={`${styles.visual} ${styles.lays}`} data-in={inView}>
                <dl className={styles.card} aria-label="Example balances">
                    <div className={styles.walletRow}>
                        <dt>SPYx</dt>
                        <dd aria-hidden="true">{held.toFixed(4)}</dd>
                        <dd className="sr-only">{AFTER.toFixed(4)} in your wallet</dd>
                    </div>
                    <div className={styles.vaultRow}>
                        <dt>Laterite vault</dt>
                        <dd>0.00</dd>
                    </div>
                </dl>
            </div>
        </section>
    );
}
