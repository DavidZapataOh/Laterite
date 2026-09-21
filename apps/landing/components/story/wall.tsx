'use client';

import type { CSSProperties } from 'react';
import { useHydrated } from '@laterite/ui/use-hydrated';
import { slice, useScrollProgress } from '@laterite/ui/use-scroll-progress';
import styles from './story.module.css';

const BRICKS = 52;
const PER_BRICK = 25;

const dollars = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
});

type Course = { offset: boolean; bricks: number[] };

/**
 * Courses are listed top to bottom, but bricks are numbered from the bottom
 * course up, left to right, the way a wall is built. Offset courses carry one
 * extra half-brick that is clipped at the edge: it shares its neighbour's
 * number and lands with it.
 */
function bond(cols: number): Course[] {
    const rows = Math.ceil(BRICKS / cols);
    const built: Course[] = [];
    let next = 0;
    for (let row = 0; row < rows; row += 1) {
        const offset = row % 2 === 1;
        const course: Course = { offset, bricks: [] };
        for (let i = 0; i < cols + (offset ? 1 : 0); i += 1) {
            course.bricks.push(offset && i === 0 ? next : next++);
        }
        built.unshift(course);
    }
    return built;
}

// Seven to a course on wide screens leaves the top course three laid and four
// open; five on narrow screens leaves two and three. Both are rendered and CSS
// shows one, so the layout never shifts after hydration.
const WIDE = bond(7);
const NARROW = bond(5);

/**
 * One year of paydays. The wall fills from the bottom course up as the band
 * scrolls through, and the figure counts what was laid, never a return.
 */
export function Wall() {
    const [ref, progress] = useScrollProgress<HTMLElement>();
    const hydrated = useHydrated();
    const laid = hydrated ? Math.round(slice(progress, 0.16, 0.56) * BRICKS) : BRICKS;

    return (
        <section
            ref={ref}
            className={`${styles.band} ${styles.wallBand} ${styles.soot} on-dark`}
            aria-labelledby="wall-title"
        >
            <div className={styles.copy}>
                <h2 id="wall-title" className={styles.headline}>
                    One year. 52 bricks.
                </h2>
                <p className={styles.figure}>
                    <span aria-hidden="true">{dollars.format(laid * PER_BRICK)}</span>
                    <span className="sr-only">
                        {dollars.format(BRICKS * PER_BRICK)} laid over one year at $25 a week
                    </span>
                    <span className={`${styles.figureNote} mono`}>Laid, not promised</span>
                </p>
            </div>

            <Bond courses={WIDE} cols={7} laid={laid} className={styles.wallWide} />
            <Bond courses={NARROW} cols={5} laid={laid} className={styles.wallNarrow} />
        </section>
    );
}

function Bond({
    courses,
    cols,
    laid,
    className,
}: {
    courses: Course[];
    cols: number;
    laid: number;
    className: string;
}) {
    return (
        <div className={`${styles.wall} ${className}`} style={{ '--cols': cols } as CSSProperties} aria-hidden="true">
            {courses.map((course, row) => (
                <div key={row} className={styles.course} data-offset={course.offset}>
                    {course.bricks.map((index, i) => (
                        <div key={i} className={styles.slot}>
                            {index >= BRICKS ? (
                                <span className={styles.wallGap} />
                            ) : (
                                <span
                                    className={styles.wallBrick}
                                    data-laid={index < laid}
                                    data-turn={(index * 7 + row * 3 + i) % 4}
                                />
                            )}
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}
