'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Progress of an element through the viewport: 0 when its top reaches the
 * bottom of the screen, 1 when its bottom leaves the top. Updated at most once
 * per frame. Visitors who ask for reduced motion get 1 straight away, so
 * everything tied to it renders in its finished state.
 */
export function useScrollProgress<T extends Element>() {
    const ref = useRef<T>(null);
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let frame = 0;
        const measure = () => {
            frame = 0;
            const rect = el.getBoundingClientRect();
            const total = rect.height + window.innerHeight;
            const next = still ? 1 : Math.min(1, Math.max(0, (window.innerHeight - rect.top) / total));
            setProgress(prev => (Math.abs(prev - next) > 0.002 ? next : prev));
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

    return [ref, progress] as const;
}

/** Remap a slice of 0..1 onto 0..1 with an ease-out, clamped. */
export function slice(progress: number, from: number, to: number) {
    const t = Math.min(1, Math.max(0, (progress - from) / (to - from)));
    return 1 - Math.pow(1 - t, 3);
}
