'use client';

import type { Address } from '@solana/kit';
import { useRequest } from '@solana/react';
import { useMemo, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { TIERS, type UserConfig, UserStatus } from '@laterite/client';
import { nextBuy, weekView } from '@/lib/dashboard';
import { readPosition } from '@/lib/position';
import { client } from '@/lib/solana';
import { Notice } from './notice';
import { Row, Rows, Screen } from './screen';
import styles from './dashboard.module.css';

type Entry = { blockTime: string; signature: string };
type HistoryBody = {
    controls: (Entry & { kind: string })[];
    incomes: (Entry & { amount: number; invested: number; kind: 'income' | 'payment'; token: string })[];
    invested: number;
    purchases: (Entry & { asset: string; assetAmount: number; paid: number; token: string })[];
};

async function readHistory(wallet: Address, signal: AbortSignal): Promise<HistoryBody> {
    const response = await fetch(`/api/history?wallet=${wallet}`, { signal });
    if (!response.ok) throw new Error(`the history could not be read: ${response.status}`);
    return response.json();
}

const explorer = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
const dollars = (amount: number) => `$${amount.toFixed(2)}`;
const usd = (raw: bigint) => Number(raw) / 1_000_000;

/** The enrolled home screen: the position in the band, the week and the next buy in rows, then the history. */
export function Dashboard({
    common,
    wallet,
    user,
    notices,
}: {
    common: { chips: ReactNode; home: string; skip: string };
    wallet: Address;
    user: UserConfig;
    notices: ReactNode;
}) {
    const t = useTranslations('app');
    const format = useFormatter();
    const position = useRequest(
        useMemo(() => (signal: AbortSignal) => readPosition(client.rpc, wallet, user, signal), [wallet, user]),
    );
    const history = useRequest(useMemo(() => (signal: AbortSignal) => readHistory(wallet, signal), [wallet]));

    const cap = String(TIERS[user.tier as 0 | 1] / 1_000_000n);
    const paused = user.status === UserStatus.Paused;
    const seal = { label: paused ? t('seal.paused') : t('seal.active'), main: t('seal.perWeek', { amount: cap }) };
    const data = position.status === 'success' ? position.data : undefined;
    const invested = history.status === 'success' && history.data ? history.data.invested : undefined;
    const asset = data?.config.assets[user.asset] ? (user.asset === 1 ? 'QQQX' : 'SPYX') : '';
    // the clock the figures are read at, taken once when the screen opens
    const [now] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
    const time = (seconds: bigint) =>
        format.dateTime(new Date(Number(seconds) * 1000), { dateStyle: 'medium', timeStyle: 'short' });

    let next = '—';
    let week = '—';
    if (data) {
        const buy = nextBuy(user, data.config.marketCalendar, now);
        next = buy.kind === 'at' ? time(buy.at) : t(`dashboard.next.${buy.kind}`);
        const view = weekView(user, data.config.userWeeklyCap, now);
        week = t('dashboard.weekValue', { cap: dollars(usd(view.cap)), spent: dollars(usd(view.spent)) });
    }

    return (
        <Screen
            {...common}
            band={{
                label: t('dashboard.position'),
                figure: data ? data.amount.toFixed(4) : '—',
                unit: asset,
                note: invested === undefined ? undefined : t('dashboard.invested', { amount: dollars(invested) }),
                busy: !data,
            }}
            seal={seal}
        >
            {notices}
            {position.status === 'error' ? <Notice>{t('dashboard.errors.position')}</Notice> : null}
            <Rows>
                <Row label={t('dashboard.toInvest')} value={dollars(usd(user.pending))} />
                <Row label={t('dashboard.nextBuy')} value={next} />
                <Row label={t('dashboard.week')} value={week} />
                {user.goalAmount > 0n && invested !== undefined ? (
                    <Row
                        label={t('dashboard.goal')}
                        value={t('dashboard.goalValue', {
                            goal: dollars(usd(user.goalAmount)),
                            invested: dollars(invested),
                        })}
                    />
                ) : null}
            </Rows>
            <section className={styles.history} aria-labelledby="history">
                <h2 id="history" className={`${styles.heading} mono`}>
                    {t('dashboard.history')}
                    <a className={styles.link} href={`/api/history/csv?wallet=${wallet}`} download>
                        {t('dashboard.csv')}
                    </a>
                </h2>
                {history.status === 'error' ? <Notice>{t('dashboard.errors.history')}</Notice> : null}
                {history.status === 'success' && history.data ? <HistoryList body={history.data} /> : null}
            </section>
        </Screen>
    );
}

function HistoryList({ body }: { body: HistoryBody }) {
    const t = useTranslations('app');
    const format = useFormatter();
    const entries = [
        ...body.purchases.map(p => ({
            ...p,
            what: t('dashboard.bought', {
                amount: p.assetAmount.toFixed(4),
                asset: p.asset,
                paid: dollars(p.paid),
                token: p.token,
            }),
        })),
        ...body.incomes.map(i => ({
            ...i,
            what: t(`dashboard.${i.kind}`, {
                amount: dollars(i.amount),
                invested: dollars(i.invested),
                token: i.token,
            }),
        })),
        ...body.controls.map(c => ({ ...c, what: t(`dashboard.controls.${c.kind}` as 'dashboard.controls.paused') })),
    ].sort((a, b) => Date.parse(b.blockTime) - Date.parse(a.blockTime));
    if (entries.length === 0) return <p className={`${styles.empty} mono`}>{t('dashboard.empty')}</p>;
    return (
        <ul className={styles.list}>
            {entries.map(entry => (
                <li key={`${entry.signature}-${entry.what}`} className={styles.item}>
                    <span className={styles.what}>{entry.what}</span>
                    <span className={`${styles.when} mono`}>
                        {format.dateTime(new Date(entry.blockTime), { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                    <a
                        className={`${styles.link} mono`}
                        href={explorer(entry.signature)}
                        target="_blank"
                        rel="noreferrer"
                    >
                        {t('dashboard.tx')}
                    </a>
                </li>
            ))}
        </ul>
    );
}
