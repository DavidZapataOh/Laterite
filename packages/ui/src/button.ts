import styles from './button.module.css';

/**
 * Button classes for an `<a>` or a `<button>`: `primary` (terracotta, kiln edge), `inverse` (lime with a soot
 * edge, for terracotta fields) and `flat` (terracotta, no edge). The placement sets height, padding and font size.
 */
export const button = { flat: styles.flat, inverse: styles.inverse, primary: styles.primary } as const;
