'use client';

import { button } from '@laterite/ui/button';
import { useInView } from '@laterite/ui/use-in-view';
import { Seal } from '@laterite/ui/seal';
import { site } from '@/lib/site';
import styles from './story.module.css';

export function Close() {
    const [ref, inView] = useInView<HTMLElement>();

    return (
        <section
            ref={ref}
            className={`${styles.band} ${styles.closeBand} ${styles.terracotta} on-dark`}
            aria-labelledby="close-title"
        >
            <div className={`${styles.copy} ${styles.lays}`} data-in={inView}>
                <h2 id="close-title" className={`${styles.headline} ${styles.closeHeadline}`}>
                    Hardens with time.
                </h2>
                <a href={site.appUrl} className={`${button.inverse} ${styles.closeCta}`}>
                    Lay the first brick
                </a>
            </div>

            <div className={styles.visual}>
                <div className={`${styles.trialSeal} ${styles.stampable}`} data-in={inView}>
                    <Seal main="TRIAL · 7 DAYS · CAP $5" mono />
                </div>
            </div>
        </section>
    );
}
