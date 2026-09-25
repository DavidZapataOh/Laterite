'use client';

import type { Address } from '@solana/kit';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { useRequest } from '@solana/react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { TIERS, TRIAL_CAP, TRIAL_SECONDS, type UserConfig } from '@laterite/client';
import { Back } from '@laterite/ui/back';
import { button } from '@laterite/ui/button';
import { Disclosure } from '@laterite/ui/disclosure';
import type { XStock } from '@laterite/devnet/addresses';
import { DOLLAR, symbolOf } from '@/lib/onboarding';
import { PermissionError, prepare, type Prepared, PREPARED_FRESH_MS, signPrepared, submit } from '@/lib/permission';
import { dollars } from '@/lib/preview';
import { client } from '@/lib/solana';
import { Notice } from './notice';
import type { Review } from './onboarding';
import styles from './permission.module.css';
import { footBrick, Receipt, Screen } from './screen';

type ScreenCommon = { home: string; skip: string; chips: ReactNode };

/**
 * Where the one signature stands once the wallet asks for it: tested again, waiting on the wallet, sent and waiting
 * on the cluster, ready again after the wallet did not sign, or stopped by a refusal that needs a new test.
 */
type Step =
    | { at: 'checking' }
    | { at: 'ready'; prepared: Prepared; declined?: PermissionError }
    | { at: 'signing'; prepared: Prepared }
    | { at: 'sending'; prepared: Prepared }
    | { at: 'failed'; error: PermissionError };

const refusal = (error: unknown) => (error instanceof PermissionError ? error : new PermissionError('network'));

/** What the wallet itself stops: signing again is the way on. */
const WALLET_REASONS = new Set(['modified', 'rejected', 'version', 'wallet']);

const LAMPORTS_PER_SOL = 1_000_000_000;

const PROGRAMS: Record<string, string> = {
    'associated-token': 'Associated Token',
    laterite: 'Laterite',
    subscriptions: 'Subscriptions',
};

/**
 * The permission screen, "the permission in numbered clauses": the weekly maximum in the band, then five clauses on
 * what the one signature can and cannot do, the caps stated by who enforces them. The sponsor route builds and
 * simulates the exact transaction as the screen opens, so the result shows before the wallet does; "Sign once" asks
 * the wallet for its one signature and hands it to the route, which co-signs and sends it.
 */
export function Permission({
    common,
    wallet,
    review,
    account,
    notices,
    onBack,
    onSigned,
}: {
    common: ScreenCommon;
    wallet: Address;
    review: Review;
    /** The exited account returning, or null for a wallet that never enrolled. */
    account: UserConfig | null;
    notices: ReactNode;
    onBack: () => void;
    /** The transaction landed, or the wallet was enrolled already: the account is read again. */
    onSigned: () => void;
}) {
    const t = useTranslations('app.permission');
    const tApp = useTranslations('app');
    const format = useFormatter();
    const locale = useLocale();
    const connected = useConnectedWallet(client);
    const { config, intent } = review;
    const { params } = intent;
    // the screen opens on a test of the exact transaction, so its result shows before the wallet does
    const tested = useRequest(
        useMemo(() => (signal: AbortSignal) => prepare(wallet, intent, signal), [intent, wallet]),
    );
    const [signing, setSigning] = useState<Step | null>(null);

    // a new screen opens at its top, not where "Review and sign" left the page
    useEffect(() => {
        window.scrollTo(0, 0);
    }, []);
    const step: Step =
        signing ??
        (tested.status === 'success'
            ? { at: 'ready', prepared: tested.data! }
            : tested.status === 'error'
              ? { at: 'failed', error: refusal(tested.error) }
              : { at: 'checking' });

    const retest = () => {
        setSigning(null);
        tested.refresh();
    };

    const sign = async () => {
        if (step.at !== 'ready') return;
        let { prepared } = step;
        // a blockhash lasts about a minute: an older transaction is built and tested again before the wallet opens
        if (Date.now() - prepared.preparedAt > PREPARED_FRESH_MS) {
            setSigning({ at: 'checking' });
            try {
                prepared = await prepare(wallet, intent);
            } catch (error) {
                return setSigning({ at: 'failed', error: refusal(error) });
            }
        }
        const signer = connected?.signer;
        if (!signer) return setSigning({ at: 'ready', declined: new PermissionError('version'), prepared });
        setSigning({ at: 'signing', prepared });
        try {
            const signed = await signPrepared(signer, prepared);
            setSigning({ at: 'sending', prepared });
            await submit(signed);
            onSigned();
        } catch (error) {
            const stopped = refusal(error);
            setSigning(
                WALLET_REASONS.has(stopped.reason)
                    ? { at: 'ready', declined: stopped, prepared }
                    : { at: 'failed', error: stopped },
            );
        }
    };

    const cap = TIERS[params.tier as 0 | 1];
    const money = (raw: bigint) => dollars(raw, locale, raw % DOLLAR !== 0n);
    const asset = (symbolOf(config.assets[params.asset]!.mint) ?? 'SPYx') as XStock;
    const tokens = config.paymentTokens.flatMap(({ mint }, index) =>
        params.paymentTokens & (1 << index) ? [symbolOf(mint) ?? mint] : [],
    );
    // the first week's cap binds a new wallet, and one that returns within its first week
    const trial = account === null || review.now < account.enrolledAt + TRIAL_SECONDS;
    const busy = step.at === 'checking' || step.at === 'signing' || step.at === 'sending';
    const problem = step.at === 'failed' ? step.error : step.at === 'ready' ? step.declined : undefined;
    const simulation = step.at === 'checking' || step.at === 'failed' ? null : step.prepared.simulation;

    const says = (error: PermissionError): string => {
        const { asset: mint, code, program, retryAfterSeconds = 60 } = error.detail;
        switch (error.reason) {
            case 'limited':
                return t('problems.limited', {
                    wait:
                        retryAfterSeconds < 3600
                            ? format.number(Math.ceil(retryAfterSeconds / 60), {
                                  style: 'unit',
                                  unit: 'minute',
                                  unitDisplay: 'long',
                              })
                            : format.number(Math.ceil(retryAfterSeconds / 3600), {
                                  style: 'unit',
                                  unit: 'hour',
                                  unitDisplay: 'long',
                              }),
                });
            case 'asset-account':
                return t('problems.asset-account', { asset: (mint && symbolOf(mint)) ?? asset });
            case 'simulation':
                return t('problems.simulation', { code: String(code ?? '?'), program: PROGRAMS[program ?? ''] ?? '?' });
            case 'enrolled':
            case 'expired':
            case 'full':
            case 'modified':
            case 'network':
            case 'paused':
            case 'rejected':
            case 'version':
            case 'wallet':
                return t(`problems.${error.reason}`);
            default:
                return t('problems.other');
        }
    };

    return (
        <Screen
            {...common}
            back={
                <Back
                    className={styles.back}
                    onClick={onBack}
                    disabled={step.at === 'signing' || step.at === 'sending'}
                >
                    {t('back')}
                </Back>
            }
            band={{
                figure: money(cap),
                label: t('label'),
                note: [t('noteSol'), t('noteFees')],
                quietNote: true,
                unit: t('unit'),
            }}
            footClassName={styles.foot}
            seal={{ label: tApp('seal.unsigned'), main: tApp('seal.perWeek', { amount: String(cap / DOLLAR) }) }}
            foot={
                <button
                    type="button"
                    className={`${button.primary} ${footBrick}`}
                    disabled={step.at !== 'ready'}
                    aria-busy={busy || undefined}
                    aria-describedby="permission-status"
                    onClick={() => void sign()}
                >
                    {step.at === 'signing'
                        ? t('signing', { wallet: connected?.wallet.name ?? '' })
                        : step.at === 'sending'
                          ? t('sending')
                          : t('sign')}
                </button>
            }
        >
            {notices}
            {problem ? (
                <Notice
                    action={
                        step.at === 'failed' ? (
                            <button
                                type="button"
                                className={`${button.outline} mono`}
                                // an enrolled wallet reads its account again; any other refusal is tested again
                                onClick={step.error.reason === 'enrolled' ? onSigned : retest}
                            >
                                {tApp('errors.retry')}
                            </button>
                        ) : undefined
                    }
                >
                    {says(problem)}
                </Notice>
            ) : null}
            <ol className={styles.clauses} aria-label={t('clauses.title')}>
                <Clause
                    number="01"
                    hint={t('clauses.capHint', {
                        cap: money(cap),
                        count: tokens.length,
                        tokens: new Intl.ListFormat(locale, { type: 'conjunction' }).format(tokens),
                        trial: trial ? 'yes' : 'no',
                        trialCap: money(TRIAL_CAP),
                    })}
                >
                    {t('clauses.cap', { cap: money(cap) })}
                </Clause>
                <Clause number="02">{t('clauses.asset', { asset })}</Clause>
                <Clause number="03">{t('clauses.elsewhere')}</Clause>
                <Clause number="04">{t('clauses.exit')}</Clause>
                <Clause number="05" hint={t('clauses.priceHint')}>
                    {t('clauses.price')}
                </Clause>
            </ol>
            <Disclosure className={`${styles.what} mono`} summary={t(`what.${asset}.summary`)}>
                <p className={styles.whatBody}>{t(`what.${asset}.body`)}</p>
            </Disclosure>
            <Receipt>
                <span id="permission-status" aria-live="polite">
                    {step.at === 'checking'
                        ? t('checking')
                        : simulation
                          ? t('simulated', {
                                sol: format.number(Number(simulation.sponsorLamports) / LAMPORTS_PER_SOL, {
                                    maximumFractionDigits: 4,
                                    minimumFractionDigits: 4,
                                }),
                            })
                          : null}
                </span>
            </Receipt>
        </Screen>
    );
}

/** One numbered clause: its number, its one line, and the fine print where the program's rule needs it. */
function Clause({ number, hint, children }: { number: string; hint?: string; children: ReactNode }) {
    return (
        <li className={styles.clause}>
            <span className={`${styles.number} mono`} aria-hidden>
                {number}
            </span>
            <span className={styles.text}>{children}</span>
            {hint ? <span className={`${styles.hint} mono`}>{hint}</span> : null}
        </li>
    );
}
