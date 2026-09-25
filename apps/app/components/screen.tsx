import Image from 'next/image';
import type { CSSProperties, ReactNode } from 'react';
import { Seal } from '@laterite/ui/seal';
import symbol from '@laterite/ui/brand/symbol-cream.svg';
import styles from './screen.module.css';

export type BandProps = {
    /** The mono label above the figure, e.g. "Your position". */
    label: string;
    /** The state's primary figure, set in giant Archivo. */
    figure: string;
    /** The figure's unit, set in mono beside it. */
    unit?: string;
    /** Set the unit small and light, so the figure takes the line. */
    quietUnit?: boolean;
    /** One mono line under the figure; as clauses, a break falls only between them. */
    note?: ReactNode | string[];
    /** Set the note small, as a receipt's small print, so the figure keeps the band. */
    quietNote?: boolean;
    /** True while the figure is still being read. */
    busy?: boolean;
};

type ScreenProps = {
    /** A step back, above the band's label. */
    back?: ReactNode;
    /** Accessible name of the home symbol. */
    home: string;
    /** The skip link's text. */
    skip: string;
    /** The chips on the right of the top bar. */
    chips: ReactNode;
    band: BandProps;
    /** The band's one action. */
    action?: ReactNode;
    /** The permission state stamped on the seam. */
    seal: { label: string; main: string };
    /** The rows under the band. */
    children?: ReactNode;
    /** The brick-shaped actions at the foot. */
    foot?: ReactNode;
    /** The foot's own class, for a screen that sets it closer to what comes before. */
    footClassName?: string;
};

/**
 * The app's one screen: a terracotta band carrying the state's figure, a course of kiln bricks with the Seal on
 * the seam, and label and value rows on lime. Desktop centres the phone composition on full-bleed fields.
 */
export function Screen({ back, home, skip, chips, band, action, seal, children, foot, footClassName }: ScreenProps) {
    return (
        <div className={styles.screen}>
            <a className="skip-link" href="#main">
                {skip}
            </a>
            <header className={`${styles.field} on-dark`}>
                <div className={`${styles.column} ${styles.bar}`}>
                    <Image src={symbol} alt={home} width={200} height={200} className={styles.symbol} unoptimized />
                    <ul className={styles.chips}>{chips}</ul>
                </div>
            </header>
            <main id="main" className={styles.main}>
                <section className={`${styles.field} ${styles.band} on-dark`} aria-busy={band.busy || undefined}>
                    <div className={styles.column}>
                        {back ? <div className={`${styles.back} mono`}>{back}</div> : null}
                        <h1 className={styles.heading}>
                            <span className={`${styles.label} mono`}>{band.label}</span>
                            <span className={styles.figureLine} data-unit={band.quietUnit ? 'quiet' : undefined}>
                                <span
                                    className={styles.figure}
                                    style={
                                        {
                                            '--ems': Math.max(ems(band.figure) + unitEms(band.unit, band.quietUnit), 3),
                                        } as CSSProperties
                                    }
                                >
                                    {band.figure}
                                </span>
                                {band.unit ? <span className={`${styles.unit} mono`}>{band.unit}</span> : null}
                            </span>
                        </h1>
                        {band.note ? (
                            <p className={`${styles.note} mono`} data-note={band.quietNote ? 'quiet' : undefined}>
                                {Array.isArray(band.note) ? <Clauses clauses={band.note} /> : band.note}
                            </p>
                        ) : null}
                        {action ? <div className={styles.action}>{action}</div> : null}
                    </div>
                </section>
                <div className={styles.seam}>
                    <div className={styles.course} aria-hidden />
                    <div className={styles.column}>
                        <div className={styles.seal}>
                            <Seal round label={seal.label} main={seal.main} />
                        </div>
                    </div>
                </div>
                <div className={`${styles.column} ${styles.body}`}>
                    {children}
                    {foot ? (
                        <div className={footClassName ? `${styles.foot} ${footClassName}` : styles.foot}>{foot}</div>
                    ) : null}
                </div>
            </main>
        </div>
    );
}

/**
 * A note in clauses: each keeps to itself, so a break falls between them, and the separator never ends or starts a
 * line.
 */
function Clauses({ clauses }: { clauses: string[] }) {
    return (
        <span className={styles.clauses}>
            <span className={styles.clauseLine}>
                {clauses.map((clause, index) => (
                    <span key={index} className={styles.clause}>
                        {clause}
                    </span>
                ))}
            </span>
        </span>
    );
}

/** The class of the foot's one brick: large, in mono, as typed. */
export const footBrick = styles.footBrick;

/**
 * About how many ems `text` advances in Archivo 900 at width 112: figures and punctuation are narrower than capitals,
 * so a line is fitted by its letters, not by its length.
 */
function ems(text: string): number {
    let width = 0;
    for (const char of text) {
        if (/[0-9$]/.test(char)) width += 0.66;
        else if (/[.,:·\s]/.test(char)) width += 0.3;
        else if (/[A-Z]/.test(char)) width += 0.82;
        else width += 0.68;
    }
    return width;
}

/**
 * About how many of the figure's ems a unit set beside it takes, so the unit stays on the figure's line: a mono
 * character advances about 0.84 of the unit's size with its tracking, the unit is 6u (quiet: 3.2u) of the figure's
 * 23.8u, and the gap and the figure's own advance past its estimate take about 0.4 em more.
 */
function unitEms(unit: string | undefined, quiet = false): number {
    if (!unit) return 0;
    return (unit.length * 0.84 * (quiet ? 3.2 : 6)) / 23.8 + 0.4;
}

/** One label and value row under the band. */
export function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className={styles.row}>
            <dt className={`${styles.rowLabel} mono`}>{label}</dt>
            <dd className={styles.rowValue} style={{ '--chars': Math.max(value.length, 5) } as CSSProperties}>
                {value}
            </dd>
        </div>
    );
}

/** The rows under the band, as one definition list. */
export function Rows({ children }: { children: ReactNode }) {
    return <dl className={styles.rows}>{children}</dl>;
}

/** The one line of support a screen may carry, set like a line on a receipt. */
export function Receipt({ children }: { children: ReactNode }) {
    return <p className={`${styles.receipt} mono`}>{children}</p>;
}
