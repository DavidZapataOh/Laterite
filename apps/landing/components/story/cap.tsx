'use client';

import { useState } from 'react';
import { useInView } from '@laterite/ui/use-in-view';
import { Seal } from '@laterite/ui/seal';
import styles from './story.module.css';

const CAPS = [10, 25] as const;

/** The visitor sets the cap here the same way they will in the app. */
export function Cap() {
    const [cap, setCap] = useState<(typeof CAPS)[number]>(25);
    const [ref, inView] = useInView<HTMLElement>();

    return (
        <section ref={ref} id="how-it-works" className={`${styles.band} ${styles.lime}`} aria-labelledby="cap-title">
            <div className={`${styles.copy} ${styles.lays}`} data-in={inView}>
                <h2 id="cap-title" className={styles.headline}>
                    You set the cap.
                </h2>
                <p className={`${styles.line} ${styles.lineTight}`} aria-live="polite">
                    ${cap} a week. We can&rsquo;t move a cent more.
                </p>
            </div>

            <div className={`${styles.visual} ${styles.lays}`} data-in={inView}>
                <div className={styles.card}>
                    <span className={styles.cardLabel}>Your cap</span>
                    <span className={styles.cardFigure}>${cap} / week</span>
                    <fieldset className={styles.choice}>
                        <legend className="sr-only">Weekly cap</legend>
                        {CAPS.map(value => (
                            <label key={value} className={styles.option}>
                                <input
                                    type="radio"
                                    name="cap"
                                    value={value}
                                    checked={cap === value}
                                    onChange={() => setCap(value)}
                                    className="sr-only"
                                />
                                ${value}
                            </label>
                        ))}
                    </fieldset>
                    {/* re-keyed so the stamp comes down again on every change */}
                    <div key={cap} className={`${styles.capSeal} ${styles.stampable}`} data-in={inView}>
                        <Seal main={`$${cap} / WK`} decorative />
                    </div>
                </div>
            </div>
        </section>
    );
}
