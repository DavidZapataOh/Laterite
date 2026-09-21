import { chip } from '@laterite/ui/chip';
import styles from './story.module.css';

const STACK = ['Solana Subscriptions & Allowances', 'Pyth', 'xStocks', 'Jupiter', 'Open source'];

export function BuiltOn() {
    return (
        <section className={`${styles.band} ${styles.builtOn} ${styles.lime}`} aria-label="Built on">
            <ul className={styles.stack}>
                {STACK.map(name => (
                    <li key={name} className={`${chip} ${styles.stackChip} mono`}>
                        {name}
                    </li>
                ))}
            </ul>
        </section>
    );
}
