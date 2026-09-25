import type { InputHTMLAttributes, ReactNode } from 'react';
import styles from './choice.module.css';

type ChoiceProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'children' | 'className' | 'type'> & {
    /** A radio for one of several, a checkbox for a choice that stands alone. */
    type?: 'checkbox' | 'radio';
    /** The label's class; the placement sets height, padding and font size. Pair it with `.mono`. */
    className?: string;
    children: ReactNode;
};

/**
 * A chip the user chooses: a native radio or checkbox inside its label, so taps, arrow keys and screen readers work
 * as the platform's own controls do. Outlined in `currentColor`, solid soot once chosen.
 */
export function Choice({ type = 'radio', className, children, ...input }: ChoiceProps) {
    return (
        <label className={className ? `${styles.choice} ${className}` : styles.choice}>
            <input type={type} className={styles.input} {...input} />
            <span>{children}</span>
        </label>
    );
}
