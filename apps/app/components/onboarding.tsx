'use client';

import type { Address } from '@solana/kit';
import { useRequest } from '@solana/react';
import { type CSSProperties, type ReactNode, useId, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { TIERS, type UserConfig } from '@laterite/client';
import { button } from '@laterite/ui/button';
import { chip } from '@laterite/ui/chip';
import { Choice } from '@laterite/ui/choice';
import { field } from '@laterite/ui/field';
import { readOnboarding } from '@/lib/account';
import {
    type Choices,
    closedReason,
    DOLLAR,
    enrollParams,
    initialChoices,
    offeredTiers,
    type OnboardingIntent,
    onboardingIntent,
    paidDefaults,
    parseDollars,
    problemOf,
    symbolOf,
    tokenOffers,
} from '@/lib/onboarding';
import { dollars, PAYDAY, paydayPreview } from '@/lib/preview';
import { client, shortAddress } from '@/lib/solana';
import { Notice } from './notice';
import styles from './onboarding.module.css';
import { type BandProps, Receipt, Screen } from './screen';

type ScreenCommon = { home: string; skip: string; chips: ReactNode };

/** The amounts typed as text, parsed when the choices are read. */
type Typed = { cushion: string; engine: string; goal: string };

/** Asks the devnet faucet for test USDC and USDT. */
async function askFaucet(wallet: Address): Promise<'failed' | 'granted' | 'limited'> {
    const response = await fetch('/api/faucet', {
        body: JSON.stringify({ wallet }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
    });
    if (response.status === 201) return 'granted';
    return response.status === 429 ? 'limited' : 'failed';
}

/** One choice row: its label, and its controls on the right. */
function Row({
    label,
    children,
    hint,
    radio = false,
}: {
    label: string;
    children: ReactNode;
    hint?: string;
    /** One of several chips: a radio group. */
    radio?: boolean;
}) {
    const id = useId();
    return (
        <div
            role={radio ? 'radiogroup' : 'group'}
            aria-labelledby={`${id}-label`}
            aria-describedby={hint ? `${id}-hint` : undefined}
            className={styles.row}
        >
            <span id={`${id}-label`} className={`${styles.label} mono`}>
                {label}
            </span>
            <div className={styles.controls}>{children}</div>
            {hint ? (
                <p id={`${id}-hint`} className={`${styles.hint} mono`}>
                    {hint}
                </p>
            ) : null}
        </div>
    );
}

/**
 * Onboarding, the screen of a connected wallet that has not enrolled or has exited: one row per choice, and the band
 * as a live preview of what a $1,000 payday would invest this week under those choices, computed with the program's
 * own rules. "Review and sign" hands the validated `EnrollParams` (or the reactivation's) to the permission screen.
 */
export function Onboarding({
    common,
    wallet,
    account,
    notices,
    onReview,
}: {
    common: ScreenCommon;
    wallet: Address;
    /** The exited account returning, or null for a wallet that never enrolled. */
    account: UserConfig | null;
    /** Notices and layers the shell owns (the declaration, errors). */
    notices: ReactNode;
    onReview: (intent: OnboardingIntent) => void;
}) {
    const t = useTranslations('app');
    const locale = useLocale();
    const data = useRequest(
        useMemo(() => (signal: AbortSignal) => readOnboarding(client.rpc, wallet, signal), [wallet]),
    );
    const [picked, setPicked] = useState<Partial<Choices>>({});
    // the tokens chosen by hand; until then, every token the wallet holds
    const [tokens, setTokens] = useState<number | null>(null);
    const [typed, setTyped] = useState<Typed>({ cushion: '20', engine: '1', goal: '' });
    const [faucet, setFaucet] = useState<'failed' | 'granted' | 'idle' | 'limited' | 'minting'>('idle');
    const money = (raw: bigint, cents = true) => dollars(raw, locale, cents);

    const loaded = data.status === 'success' ? data.data : undefined;
    if (!loaded) {
        const band: BandProps = { busy: data.status !== 'error', figure: '—', label: t('account.reading') };
        return (
            <Screen {...common} band={band} seal={{ label: t('seal.none'), main: t('seal.zero') }}>
                {notices}
                {data.status === 'error' ? (
                    <Notice
                        action={
                            <button type="button" className={`${button.outline} mono`} onClick={() => data.refresh()}>
                                {t('errors.retry')}
                            </button>
                        }
                    >
                        {t('errors.rpc')}
                    </Notice>
                ) : null}
            </Screen>
        );
    }

    const { config, state } = loaded;
    const closed = closedReason(config);
    if (closed) {
        return (
            <Screen
                {...common}
                band={{
                    figure: t('onboarding.closed.figure'),
                    label: t('onboarding.closed.label'),
                    note: t(`onboarding.closed.${closed}`),
                }}
                seal={{ label: t('seal.none'), main: t('seal.zero') }}
            >
                {notices}
                <Receipt>{t('onboarding.closed.receipt')}</Receipt>
            </Screen>
        );
    }

    const offers = tokenOffers(config, state);
    const offered = offers.reduce((mask, offer) => (offer.offered ? mask | (1 << offer.paymentToken) : mask), 0);
    const tiers = offeredTiers(config);
    const amounts = {
        cushion: parseDollars(typed.cushion, locale),
        engine: parseDollars(typed.engine, locale),
        goal: typed.goal.trim() === '' ? 0n : parseDollars(typed.goal, locale),
    };
    const choices: Choices = {
        ...initialChoices(offered),
        tier: tiers[0] ?? 0,
        ...picked,
        cushion: amounts.cushion ?? 0n,
        engineAmount: amounts.engine ?? 0n,
        goalAmount: amounts.goal ?? 0n,
        paymentTokens: (tokens ?? offered) & offered,
    };
    const typo =
        amounts.cushion === null || amounts.goal === null || (choices.engine !== 'off' && amounts.engine === null);
    const problem = typo ? 'amount' : problemOf(choices, config, offers);
    const pick = (changes: Partial<Choices>) => setPicked(current => ({ ...current, ...changes }));
    const toggleToken = (paymentToken: number) => setTokens(choices.paymentTokens ^ (1 << paymentToken));

    const tierCap = TIERS[choices.tier as 0 | 1];
    const preview = paydayPreview({
        account,
        balances: offers.map(offer => offer.balance),
        config,
        now: state.now,
        // the goal does not change what is bought, and its name may still be too long to encode; with no token yet,
        // the preview shows what the rules would buy through USDC
        params: enrollParams({ ...choices, goalLabel: '', paymentTokens: choices.paymentTokens || 1 }),
        user: wallet,
    });
    const perWeek = (raw: bigint) => t('onboarding.perWeekAmount', { amount: money(raw, raw % DOLLAR !== 0n) });
    const limit =
        preview.binding === 'cap'
            ? preview.trial
                ? t('onboarding.noteTrial', { trial: money(preview.cap, false) })
                : t('onboarding.noteCap', { cap: money(preview.cap, false) })
            : preview.binding === 'balance'
              ? t('onboarding.noteBalance')
              : t('onboarding.noteRules', { cap: money(tierCap, false) });
    // the following full week from the same rules and what waits: never more than the cap
    const tail =
        preview.nextWeek > 0n
            ? t('onboarding.then', { weekly: perWeek(preview.nextWeek) })
            : t('onboarding.thenNothing');

    const fund = async () => {
        setFaucet('minting');
        const result = await askFaucet(wallet).catch(() => 'failed' as const);
        setFaucet(result);
        if (result === 'granted') data.refresh();
    };
    const missing = offers.some(offer => !offer.offered && !offer.frozen);
    const problemId = 'onboarding-problem';
    // $5,000 in the locale's digits, without its sign
    const goalExample = money(5_000n * DOLLAR, false).slice(1);

    return (
        <Screen
            {...common}
            band={{
                figure: money(preview.invested),
                label: t('onboarding.label', { amount: money(PAYDAY, false) }),
                // each clause keeps to itself: a break falls between them, and the separator never ends or starts a line
                note: (
                    <span className={styles.clauses}>
                        <span className={styles.clauseLine}>
                            <span className={styles.clause}>{limit}</span>
                            <span className={styles.clause}>{tail}</span>
                        </span>
                    </span>
                ),
                quietUnit: true,
                unit: t('onboarding.unit'),
            }}
            seal={{ label: t('seal.preview'), main: t('seal.perWeek', { amount: String(tierCap / DOLLAR) }) }}
            foot={
                <button
                    type="button"
                    className={`${button.primary} ${styles.review}`}
                    disabled={problem !== null}
                    aria-describedby={problem ? problemId : undefined}
                    onClick={() => onReview(onboardingIntent(choices, state))}
                >
                    {t('onboarding.review')}
                </button>
            }
        >
            {notices}
            <form className={styles.rows} onSubmit={event => event.preventDefault()}>
                <Row radio label={t('onboarding.paid')}>
                    {(['stablecoins', 'savings'] as const).map(paid => (
                        <Choice
                            key={paid}
                            name="paid"
                            className={`${styles.chip} mono`}
                            checked={choices.paid === paid}
                            onChange={() => {
                                pick(paidDefaults(paid));
                                if (paid === 'savings') setTyped(current => ({ ...current, engine: '1' }));
                            }}
                        >
                            {t(paid === 'stablecoins' ? 'onboarding.paidStablecoins' : 'onboarding.paidSavings')}
                        </Choice>
                    ))}
                </Row>
                <Row radio label={t('onboarding.cap')}>
                    {tiers.map(tier => (
                        <Choice
                            key={tier}
                            name="tier"
                            className={`${styles.chip} mono`}
                            checked={choices.tier === tier}
                            onChange={() => pick({ tier })}
                        >
                            {money(TIERS[tier as 0 | 1], false)}
                        </Choice>
                    ))}
                </Row>
                <Row
                    label={t('onboarding.engine')}
                    hint={
                        choices.engine === 'daily'
                            ? t('onboarding.engineDailyHint')
                            : choices.engine === 'weekly'
                              ? t('onboarding.engineWeeklyHint')
                              : undefined
                    }
                >
                    {(['off', 'daily', 'weekly'] as const).map(engine => (
                        <Choice
                            key={engine}
                            name="engine"
                            className={`${styles.chip} mono`}
                            checked={choices.engine === engine}
                            onChange={() => pick({ engine })}
                        >
                            {t(
                                engine === 'off'
                                    ? 'onboarding.engineOff'
                                    : engine === 'daily'
                                      ? 'onboarding.engineDaily'
                                      : 'onboarding.engineWeekly',
                            )}
                        </Choice>
                    ))}
                    {choices.engine !== 'off' ? (
                        <label className={`${field} ${styles.amount} mono`}>
                            $
                            <input
                                inputMode="decimal"
                                aria-label={t('onboarding.engineAmount')}
                                aria-invalid={amounts.engine === null || problem === 'engineAboveCap' || undefined}
                                value={typed.engine}
                                style={{ '--chars': Math.max(typed.engine.length, 2) } as CSSProperties}
                                onChange={event => setTyped(current => ({ ...current, engine: event.target.value }))}
                            />
                            <span>{t(choices.engine === 'daily' ? 'onboarding.perDay' : 'onboarding.perWeek')}</span>
                        </label>
                    ) : null}
                </Row>
                <Row label={t('onboarding.income')}>
                    <span className={`${chip} ${styles.chip} ${styles.fact} mono`}>{t('onboarding.incomeRule')}</span>
                    <Choice
                        type="checkbox"
                        className={`${styles.chip} mono`}
                        checked={choices.incomeRule}
                        aria-label={t('onboarding.income')}
                        onChange={event => pick({ incomeRule: event.target.checked })}
                    >
                        {t(choices.incomeRule ? 'onboarding.on' : 'onboarding.off')}
                    </Choice>
                </Row>
                <Row
                    radio
                    label={t('onboarding.change')}
                    hint={
                        choices.changeMultiplier > 0
                            ? t('onboarding.changeHint', { times: choices.changeMultiplier })
                            : undefined
                    }
                >
                    {[0, 1, 2, 3].map(times => (
                        <Choice
                            key={times}
                            name="change"
                            className={`${styles.chip} mono`}
                            checked={choices.changeMultiplier === times}
                            onChange={() => pick({ changeMultiplier: times })}
                        >
                            {times === 0 ? t('onboarding.off') : t('onboarding.changeTimes', { times })}
                        </Choice>
                    ))}
                </Row>
                <Row label={t('onboarding.cushion')}>
                    <label className={`${field} ${styles.wide} mono`}>
                        $
                        <input
                            inputMode="decimal"
                            aria-label={t('onboarding.cushionAmount')}
                            aria-invalid={amounts.cushion === null || undefined}
                            value={typed.cushion}
                            style={{ '--chars': Math.max(typed.cushion.length, 2) } as CSSProperties}
                            onChange={event => setTyped(current => ({ ...current, cushion: event.target.value }))}
                        />
                        <span>{t('onboarding.stays')}</span>
                    </label>
                </Row>
                <Row label={t('onboarding.goal')}>
                    <label className={`${field} ${styles.wide} mono`}>
                        <input
                            aria-label={t('onboarding.goalLabel')}
                            aria-invalid={problem === 'goalLabel' || undefined}
                            placeholder={t('onboarding.goalPlaceholder')}
                            value={choices.goalLabel}
                            style={
                                {
                                    // a long name scrolls in its own box, so the amount beside it stays whole
                                    '--chars': Math.min(
                                        Math.max((choices.goalLabel || t('onboarding.goalPlaceholder')).length, 2),
                                        12,
                                    ),
                                } as CSSProperties
                            }
                            onChange={event => pick({ goalLabel: event.target.value })}
                        />
                        <span aria-hidden>·</span>
                        $
                        <input
                            inputMode="decimal"
                            aria-label={t('onboarding.goalAmount')}
                            aria-invalid={amounts.goal === null || undefined}
                            placeholder={goalExample}
                            value={typed.goal}
                            style={{ '--chars': Math.max((typed.goal || goalExample).length, 2) } as CSSProperties}
                            onChange={event => setTyped(current => ({ ...current, goal: event.target.value }))}
                        />
                    </label>
                </Row>
                <Row radio label={t('onboarding.asset')}>
                    {config.assets.map((asset, index) => (
                        <Choice
                            key={asset.mint}
                            name="asset"
                            className={`${styles.chip} mono`}
                            checked={choices.asset === index}
                            onChange={() => pick({ asset: index })}
                        >
                            {symbolOf(asset.mint) ?? shortAddress(asset.mint)}
                        </Choice>
                    ))}
                </Row>
                <Row label={t('onboarding.tokens')} hint={t(offered ? 'onboarding.tokensHint' : 'onboarding.noTokens')}>
                    {offers
                        .filter(offer => offer.offered)
                        .map(offer => (
                            <Choice
                                key={offer.paymentToken}
                                type="checkbox"
                                className={`${styles.chip} mono`}
                                checked={(choices.paymentTokens & (1 << offer.paymentToken)) !== 0}
                                onChange={() => toggleToken(offer.paymentToken)}
                            >
                                {offer.symbol ?? shortAddress(config.paymentTokens[offer.paymentToken]!.mint)}
                            </Choice>
                        ))}
                    {missing ? (
                        <button
                            type="button"
                            className={`${button.outline} ${styles.chip} ${styles.faucet} mono`}
                            disabled={faucet === 'minting' || faucet === 'limited'}
                            aria-busy={faucet === 'minting' || undefined}
                            onClick={fund}
                        >
                            {faucet === 'minting' ? t('onboarding.faucetBusy') : t('onboarding.faucet')}
                        </button>
                    ) : null}
                </Row>
            </form>
            {faucet === 'limited' || faucet === 'failed' ? (
                <Notice>{t(faucet === 'limited' ? 'onboarding.faucetLimited' : 'onboarding.faucetFailed')}</Notice>
            ) : null}
            {offers
                .filter(offer => offer.delegate && choices.paymentTokens & (1 << offer.paymentToken))
                .map(offer => (
                    <Notice
                        key={offer.paymentToken}
                        action={
                            <Choice
                                type="checkbox"
                                className={`${styles.replace} mono`}
                                checked={(choices.replaceDelegates & (1 << offer.paymentToken)) !== 0}
                                onChange={() =>
                                    pick({ replaceDelegates: choices.replaceDelegates ^ (1 << offer.paymentToken) })
                                }
                            >
                                {t('onboarding.replace')}
                            </Choice>
                        }
                    >
                        {t('onboarding.delegate', {
                            amount: money(offer.delegate!.amount),
                            delegate: shortAddress(offer.delegate!.address),
                            token: offer.symbol ?? '',
                        })}
                    </Notice>
                ))}
            {account ? <Receipt>{t('onboarding.exited')}</Receipt> : null}
            {problem ? (
                <p id={problemId} className={`${styles.problem} mono`} aria-live="polite">
                    {t(`onboarding.problems.${problem === 'noToken' && offered === 0 ? 'faucetFirst' : problem}`)}
                </p>
            ) : null}
        </Screen>
    );
}
