import { getTranslations } from 'next-intl/server';
import { chip } from '@laterite/ui/chip';
import styles from './story.module.css';

const STACK = ['subscriptions', 'pyth', 'xstocks', 'jupiter', 'openSource'] as const;

export async function BuiltOn() {
    const t = await getTranslations('landing.builtOn');

    return (
        <section className={`${styles.band} ${styles.builtOn} ${styles.lime}`} aria-label={t('label')}>
            <ul className={styles.stack}>
                {STACK.map(key => (
                    <li key={key} className={`${chip} ${styles.stackChip} mono`}>
                        {t(`stack.${key}`)}
                    </li>
                ))}
            </ul>
        </section>
    );
}
