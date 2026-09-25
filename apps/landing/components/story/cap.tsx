'use client';

import { useState } from 'react';
import { useInView } from '@laterite/ui/use-in-view';
import { Seal } from '@laterite/ui/seal';
import styles from './story.module.css';

type Option = { value: number; line: string; figure: string; seal: string; total: string; perToken: string };

/**
 * The visitor sets the cap here the same way they will in the app. It opens on the last option, the hero's $25. Both
 * caps are named with who enforces them: Laterite's program the total, the Subscriptions program each token.
 */
export function Cap({
    headline,
    label,
    legend,
    enforcers,
    options,
}: {
    headline: string;
    label: string;
    legend: string;
    enforcers: { label: string; laterite: string; subscriptions: string };
    options: Option[];
}) {
    const [cap, setCap] = useState(options.at(-1)!.value);
    const [ref, inView] = useInView<HTMLElement>();
    const chosen = options.find(option => option.value === cap)!;

    return (
        <section ref={ref} id="how-it-works" className={`${styles.band} ${styles.lime}`} aria-labelledby="cap-title">
            <div className={`${styles.copy} ${styles.lays}`} data-in={inView}>
                <h2 id="cap-title" className={styles.headline}>
                    {headline}
                </h2>
                <p className={`${styles.line} ${styles.lineTight}`} aria-live="polite">
                    {chosen.line}
                </p>
            </div>

            <div className={`${styles.visual} ${styles.lays}`} data-in={inView}>
                <div className={styles.card}>
                    <span className={styles.cardLabel}>{label}</span>
                    <span className={styles.cardFigure}>{chosen.figure}</span>
                    <fieldset className={styles.choice}>
                        <legend className="sr-only">{legend}</legend>
                        {options.map(({ value }) => (
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
                    <dl className={styles.enforcers} aria-label={enforcers.label}>
                        <div>
                            <dt>{enforcers.laterite}</dt>
                            <dd>{chosen.total}</dd>
                        </div>
                        <div>
                            <dt>{enforcers.subscriptions}</dt>
                            <dd>{chosen.perToken}</dd>
                        </div>
                    </dl>
                    {/* re-keyed so the stamp comes down again on every change */}
                    <div key={cap} className={`${styles.capSeal} ${styles.stampable}`} data-in={inView}>
                        <Seal main={chosen.seal} decorative />
                    </div>
                </div>
            </div>
        </section>
    );
}
