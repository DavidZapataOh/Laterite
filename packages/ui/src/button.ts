import styles from './button.module.css';

/**
 * Button classes for an `<a>` or a `<button>`: `primary` (terracotta, kiln edge), `inverse` (lime with a soot
 * edge, for terracotta fields), `flat` (terracotta, no edge) and `outline` (a 2px `currentColor` outline on the
 * field, for secondary actions). The placement sets height, padding and font size.
 */
export const button = {
    flat: styles.flat,
    inverse: styles.inverse,
    outline: styles.outline,
    primary: styles.primary,
} as const;
