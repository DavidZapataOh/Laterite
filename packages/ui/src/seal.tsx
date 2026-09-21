'use client';

import { useId } from 'react';
import styles from './seal.module.css';

type SealProps = {
    /** The big line, e.g. "$25 / WK". */
    main: string;
    /** Optional small line above the main one. */
    label?: string;
    /** Set the main line in the mono face, for longer stamps. */
    mono?: boolean;
    /** Hide from assistive tech when the same words are already on the page. */
    decorative?: boolean;
    className?: string;
};

/**
 * A brickmaker's stamp. Every purchase and every permission state is sealed,
 * so the seal is drawn in code and takes live values.
 * Colour comes from `currentColor`.
 */
export function Seal({ main, label, mono = false, decorative = false, className }: SealProps) {
    const ink = useId();
    const width = mono ? 470 : 300;
    // no two impressions of a rubber stamp are alike
    const seed = [...main].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 97;
    return (
        <svg
            className={`${styles.seal} ${className ?? ''}`}
            viewBox={`0 0 ${width} 120`}
            {...(decorative
                ? { 'aria-hidden': true }
                : { role: 'img', 'aria-label': label ? `${label}: ${main}` : main })}
        >
            <defs>
                {/* a dry rubber stamp never prints a clean edge */}
                <filter id={ink} x="-5%" y="-10%" width="110%" height="120%">
                    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={seed} result="grain" />
                    <feDisplacementMap in="SourceGraphic" in2="grain" scale="2.4" />
                </filter>
            </defs>
            <g filter={`url(#${ink})`} fill="none" stroke="currentColor">
                <rect x="5" y="5" width={width - 10} height="110" rx="16" strokeWidth="6" />
                <rect x="17" y="17" width={width - 34} height="86" rx="9" strokeWidth="2" />
                {label ? (
                    <text
                        x={width / 2}
                        y="42"
                        className={styles.label}
                        textAnchor="middle"
                        stroke="none"
                        fill="currentColor"
                    >
                        {label}
                    </text>
                ) : null}
                <text
                    x={width / 2}
                    y={label ? 84 : 74}
                    className={mono ? styles.mainMono : styles.main}
                    textAnchor="middle"
                    stroke="none"
                    fill="currentColor"
                >
                    {main}
                </text>
            </g>
        </svg>
    );
}
