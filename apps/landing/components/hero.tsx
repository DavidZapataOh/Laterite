import { Fragment } from 'react';
import { getTranslations } from 'next-intl/server';
import { button } from '@laterite/ui/button';
import { chip } from '@laterite/ui/chip';
import { site } from '@/lib/site';
import { HeroBrick } from './hero-brick';
import styles from './hero.module.css';

const CHIPS = ['custody', 'cap', 'revoke'] as const;

export async function Hero() {
    const t = await getTranslations('landing.hero');
    const first = t('first').split(' ');

    return (
        <section className={styles.hero} aria-labelledby="hero-title">
            <div className={styles.wall}>
                <h1 id="hero-title" className={styles.type}>
                    <span className={styles.course}>
                        {first.map((word, index) => (
                            <Fragment key={word}>
                                {index > 0 ? ' ' : null}
                                <span className={styles.word}>{word}</span>
                            </Fragment>
                        ))}
                    </span>{' '}
                    <span className={styles.course}>{t('second')}</span>{' '}
                    <span className={styles.course}>{t('third')}</span>
                </h1>

                <HeroBrick
                    flowLabel={t('flowLabel')}
                    steps={[t('income'), t('cap'), t('brick')]}
                    brickAlt={t('brickAlt')}
                />
            </div>

            <div className={styles.base}>
                <div className={styles.pitch}>
                    <p className={styles.sentence}>{t('sentence')}</p>
                    <div className={styles.actions}>
                        <a href={site.appUrl} className={`${button.primary} ${styles.cta}`}>
                            {t('cta')}
                        </a>
                        <ul className={styles.chips}>
                            {CHIPS.map(key => (
                                <li key={key} className={`${chip} ${styles.chip} mono`}>
                                    {t(`chips.${key}`)}
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>

                <a href="#how-it-works" className={`${styles.next} mono`}>
                    {t('next')}
                    <svg viewBox="0 0 16 24" aria-hidden="true" className={styles.nextArrow}>
                        <path d="M8 1v20M2 15l6 7 6-7" fill="none" stroke="currentColor" strokeWidth="2" />
                    </svg>
                </a>
            </div>
        </section>
    );
}
