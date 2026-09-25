import { getLocale, getTranslations } from 'next-intl/server';
import { Autopilot } from './autopilot';
import { BuiltOn } from './built-on';
import { Cannot } from './cannot';
import { Cap } from './cap';
import { Close } from './close';
import { Spine } from './spine';
import { Wall } from './wall';
import { Yours } from './yours';
import { dollars, example, shares } from '@/lib/example';
import styles from './story.module.css';

const CAPS = [10, 25];

// Illustrative paydays, one a week: three laid, today's falling, one still ahead.
const PAYDAYS = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03'];

/** The bands in page order; the client bands take their copy from here, already translated. */
export async function Story() {
    const locale = await getLocale();
    const t = await getTranslations('landing');
    const day = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', timeZone: 'UTC' });

    return (
        <div className={styles.story}>
            <div className={styles.bands}>
                <Cap
                    headline={t('cap.headline')}
                    label={t('cap.label')}
                    legend={t('cap.legend')}
                    enforcers={{
                        label: t('cap.enforcers'),
                        laterite: t('cap.laterite'),
                        subscriptions: t('cap.subscriptions'),
                    }}
                    options={CAPS.map(value => {
                        const cap = `$${value}`;
                        return {
                            value,
                            line: t('cap.line', { cap }),
                            figure: t('cap.figure', { cap }),
                            seal: t('cap.seal', { cap }),
                            total: t('cap.total', { cap }),
                            perToken: t('cap.perToken', { cap }),
                        };
                    })}
                />
                <Autopilot
                    headline={t('autopilot.headline')}
                    line={t('autopilot.line')}
                    stripLabel={t('autopilot.stripLabel')}
                    laidAlt={t('autopilot.laidAlt')}
                    todayAlt={t('autopilot.todayAlt')}
                    dates={PAYDAYS.map(date => day.format(new Date(date)))}
                />
                <Yours
                    locale={locale}
                    headline={t('yours.headline')}
                    line={t('yours.line')}
                    balancesLabel={t('yours.balancesLabel')}
                    held={t('yours.held', { amount: shares(locale).format(example.wallet.after) })}
                    vault={t('yours.vault')}
                />
                <Wall
                    locale={locale}
                    headline={t('wall.headline')}
                    total={t('wall.total', {
                        total: dollars(locale).format(example.bricks * example.cap),
                        cap: `$${example.cap}`,
                    })}
                    note={t('wall.note')}
                />
                <Cannot
                    headline={t('cannot.headline')}
                    limits={[
                        t('cannot.limits.cap'),
                        t('cannot.limits.destination'),
                        t('cannot.limits.custody'),
                        t('cannot.limits.exit'),
                    ]}
                />
                <BuiltOn />
                <Close headline={t('close.headline')} cta={t('close.cta')} seal={t('close.seal')} />
            </div>
            <Spine />
        </div>
    );
}
