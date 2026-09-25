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
    /** A round stamp: the label runs along both arcs and the main line sits in the middle. */
    round?: boolean;
    /** Hide from assistive tech when the same words are already on the page. */
    decorative?: boolean;
    className?: string;
};

/**
 * A brickmaker's stamp. Every purchase and every permission state is sealed,
 * so the seal is drawn in code and takes live values.
 * Colour comes from `currentColor`; a round stamp's paper from `--seal-paper` (none by default).
 */
export function Seal({ main, label, mono = false, round = false, decorative = false, className }: SealProps) {
    const ink = useId();
    const width = mono ? 470 : 300;
    // no two impressions of a rubber stamp are alike
    const seed = [...main].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 97;
    const a11y = decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': label ? `${label}: ${main}` : main };
    if (round) {
        // Archivo 900 at width 112 advances about 0.62em a character; a longer line is fitted to the inner ring
        const fit = main.length * 0.62 * 44 > 172 ? { textLength: 172, lengthAdjust: 'spacingAndGlyphs' } : {};
        // the ring label, uppercase at width 118 with its tracking, advances about 0.86em a character
        const ringFit =
            label && label.length * 0.86 * 22 > 190 ? { textLength: 190, lengthAdjust: 'spacingAndGlyphs' } : {};
        return (
            <svg className={`${styles.seal} ${className ?? ''}`} viewBox="0 0 240 240" {...a11y}>
                <defs>
                    <filter id={ink} x="-5%" y="-5%" width="110%" height="110%">
                        <feTurbulence
                            type="fractalNoise"
                            baseFrequency="0.9"
                            numOctaves="2"
                            seed={seed}
                            result="grain"
                        />
                        <feDisplacementMap in="SourceGraphic" in2="grain" scale="2.4" />
                    </filter>
                    <path id={`${ink}-top`} d="M 38 120 A 82 82 0 0 1 202 120" />
                    <path id={`${ink}-bottom`} d="M 24 120 A 96 96 0 0 0 216 120" />
                </defs>
                <circle cx="120" cy="120" r="117" className={styles.paper} />
                <g filter={`url(#${ink})`} fill="none" stroke="currentColor">
                    <circle cx="120" cy="120" r="112" strokeWidth="6" />
                    <circle cx="120" cy="120" r="101" strokeWidth="2" />
                    {label ? (
                        <g className={styles.ring} stroke="none" fill="currentColor">
                            {['top', 'bottom'].map(arc => (
                                <text key={arc} textAnchor="middle">
                                    <textPath href={`#${ink}-${arc}`} startOffset="50%" {...ringFit}>
                                        {label}
                                    </textPath>
                                </text>
                            ))}
                        </g>
                    ) : null}
                    <text
                        x="120"
                        y="136"
                        className={styles.roundMain}
                        textAnchor="middle"
                        stroke="none"
                        fill="currentColor"
                        {...fit}
                    >
                        {main}
                    </text>
                </g>
            </svg>
        );
    }
    return (
        <svg className={`${styles.seal} ${className ?? ''}`} viewBox={`0 0 ${width} 120`} {...a11y}>
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
