'use client';

import { useEffect, useRef, useState } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import styles from './spine.module.css';

const BRICKS = 52;

/**
 * The wall that runs down the page: fifty-two brick ends, one per week of the
 * year the story describes. It gains a brick for every stretch the visitor has
 * read.
 */
export function Spine() {
    const ref = useRef<HTMLOListElement>(null);
    const hydrated = useHydrated();
    const [read, setRead] = useState(0);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let frame = 0;
        const measure = () => {
            frame = 0;
            const rect = el.getBoundingClientRect();
            const reached = still ? rect.height : window.innerHeight * 0.74 - rect.top;
            const next = Math.max(0, Math.min(BRICKS, Math.floor((reached / rect.height) * BRICKS)));
            setRead(prev => (prev === next ? prev : next));
        };
        const onScroll = () => {
            if (!frame) frame = requestAnimationFrame(measure);
        };

        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        return () => {
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onScroll);
            if (frame) cancelAnimationFrame(frame);
        };
    }, []);

    const laid = hydrated ? read : BRICKS;

    return (
        <ol ref={ref} className={styles.spine} aria-hidden="true">
            {Array.from({ length: BRICKS }, (_, index) => (
                <li key={index} className={styles.slot}>
                    <span className={styles.brick} data-laid={index < laid} data-turn={index % 4} />
                </li>
            ))}
        </ol>
    );
}
