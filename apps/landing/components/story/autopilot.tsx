'use client';

import Image from 'next/image';
import type { CSSProperties } from 'react';
import { useInView } from '@laterite/ui/use-in-view';
import { slice, useScrollProgress } from '@laterite/ui/use-scroll-progress';
import styles from './story.module.css';

const STATES = ['laid', 'laid', 'laid', 'today', 'ahead'] as const;

/** Five illustrative paydays, `dates` in order: three laid, today's falling, one still ahead. */
export function Autopilot({
    headline,
    line,
    stripLabel,
    laidAlt,
    todayAlt,
    dates,
}: {
    headline: string;
    line: string;
    stripLabel: string;
    laidAlt: string;
    todayAlt: string;
    dates: string[];
}) {
    const [band, progress] = useScrollProgress<HTMLElement>();
    const [strip, inView] = useInView<HTMLOListElement>(0.5);
    const fall = slice(progress, 0.34, 0.66);

    return (
        <section
            ref={band}
            className={`${styles.band} ${styles.stripBand} ${styles.terracotta} on-dark`}
            aria-labelledby="autopilot-title"
        >
            <div className={styles.copy}>
                <h2 id="autopilot-title" className={styles.headline}>
                    {headline}
                </h2>
                <p className={styles.line}>{line}</p>
            </div>

            <ol ref={strip} className={styles.strip} data-in={inView} aria-label={stripLabel}>
                {dates.map((date, index) => {
                    const state = STATES[index];
                    return (
                        <li key={date} className={styles.payday}>
                            {state === 'ahead' ? (
                                <span className={styles.ahead} aria-hidden="true" />
                            ) : (
                                <Image
                                    src="/body/brick-laid.png"
                                    alt={state === 'today' ? todayAlt : laidAlt}
                                    width={1090}
                                    height={506}
                                    sizes="(max-width: 720px) 24vw, 18vw"
                                    className={`${styles.stripBrick} ${state === 'today' ? styles.falling : styles.dropped}`}
                                    style={
                                        state === 'today'
                                            ? ({ '--fall': fall } as CSSProperties)
                                            : { transitionDelay: `${index * 110}ms` }
                                    }
                                    draggable={false}
                                />
                            )}
                            <span className={styles.date}>{date}</span>
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}
