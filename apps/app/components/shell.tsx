'use client';

import type { Address } from '@solana/kit';
import {
    useConnect,
    useConnectedWallet,
    useDisconnect,
    useWallets,
    useWalletStatus,
} from '@solana/kit-plugin-wallet/react';
import { useRequest } from '@solana/react';
import { useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { TIERS, UserStatus } from '@laterite/client';
import { button } from '@laterite/ui/button';
import { readAccount } from '@/lib/account';
import { client, isUserRejection, type UiWallet } from '@/lib/solana';
import { BarChips } from './chips';
import { DeclarationLayer } from './declaration-layer';
import { Notice } from './notice';
import { type BandProps, Receipt, Row, Rows, Screen } from './screen';
import { WalletChip } from './wallet-chip';
import { WalletLayer } from './wallet-layer';

/** Whether `wallet` has declared the current eligibility declaration. */
async function readEligibility(wallet: Address, signal: AbortSignal): Promise<{ declared: boolean }> {
    const response = await fetch(`/api/eligibility?wallet=${wallet}`, { signal });
    if (!response.ok) throw new Error(`the declaration could not be read: ${response.status}`);
    return response.json();
}

/** The app's one screen in the state the wallet and the account put it in. */
export function Shell() {
    const t = useTranslations('app');
    const format = useFormatter();
    const status = useWalletStatus(client);
    const wallets = useWallets(client);
    const connected = useConnectedWallet(client);
    const connect = useConnect(client);
    const disconnect = useDisconnect(client);
    const layer = useRef<HTMLDialogElement>(null);
    const [chosen, setChosen] = useState<UiWallet | null>(null);

    const address = connected?.account.address as Address | undefined;
    const account = useRequest(
        useMemo(() => (address ? (signal: AbortSignal) => readAccount(client.rpc, address, signal) : null), [address]),
    );
    const eligibility = useRequest(
        useMemo(() => (address ? (signal: AbortSignal) => readEligibility(address, signal) : null), [address]),
    );

    const choose = (wallet: UiWallet) => {
        layer.current?.close();
        setChosen(wallet);
        connect.dispatch(wallet);
    };
    const connectOne = () => (wallets.length === 1 ? choose(wallets[0]) : layer.current?.showModal());

    const common = {
        home: t('bar.home'),
        skip: t('skip'),
        chips: (
            <>
                <BarChips />
                {address ? <WalletChip address={address} onDisconnect={() => disconnect.dispatch()} /> : null}
            </>
        ),
    };
    const noPermission = { label: t('seal.none'), main: t('seal.zero') };

    if (address) {
        const state = account.status === 'success' ? account.data : undefined;
        let band: BandProps = { label: t('account.reading'), figure: '—', busy: true };
        let seal = noPermission;
        let next: string | null = null;
        if (state?.kind === 'new') {
            band = { label: t('account.label'), figure: '$0', unit: t('account.unit'), note: t('account.notEnrolled') };
            next = t('account.next');
        } else if (state?.kind === 'exited') {
            band = { label: t('account.label'), figure: '$0', unit: t('account.unit'), note: t('account.exited') };
            seal = { label: t('seal.revoked'), main: t('seal.zero') };
        } else if (state?.kind === 'enrolled') {
            const cap = String(TIERS[state.config.tier] / 1_000_000n);
            const date = format.dateTime(new Date(Number(state.config.enrolledAt) * 1000), { dateStyle: 'medium' });
            const paused = state.config.status === UserStatus.Paused;
            band = {
                label: t('account.label'),
                figure: `$${cap}`,
                unit: t('account.unit'),
                note: paused ? t('account.paused', { date }) : t('account.active', { date }),
            };
            seal = { label: paused ? t('seal.paused') : t('seal.active'), main: t('seal.perWeek', { amount: cap }) };
        }
        return (
            <Screen {...common} band={band} seal={seal}>
                {eligibility.status === 'success' && !eligibility.data?.declared ? (
                    <DeclarationLayer
                        wallet={address}
                        walletName={connected!.wallet.name}
                        onDeclared={() => eligibility.refresh()}
                        onDisconnect={() => disconnect.dispatch()}
                    />
                ) : null}
                {eligibility.status === 'error' ? (
                    <Notice
                        action={
                            <button
                                type="button"
                                className={`${button.outline} mono`}
                                onClick={() => eligibility.refresh()}
                            >
                                {t('errors.retry')}
                            </button>
                        }
                    >
                        {t('errors.eligibility')}
                    </Notice>
                ) : null}
                {account.status === 'error' ? (
                    <Notice
                        action={
                            <button
                                type="button"
                                className={`${button.outline} mono`}
                                onClick={() => account.refresh()}
                            >
                                {t('errors.retry')}
                            </button>
                        }
                    >
                        {t('errors.rpc')}
                    </Notice>
                ) : null}
                {next ? <Receipt>{next}</Receipt> : null}
            </Screen>
        );
    }

    const failed = connect.status === 'error' && chosen ? chosen.name : null;
    // a pending connection keeps the screen still: only the band's action says what it waits on
    const pending =
        status === 'connecting' && chosen
            ? t('connect.note', { wallet: chosen.name })
            : status === 'connecting' || status === 'reconnecting'
              ? t('connect.reconnecting')
              : null;
    return (
        <Screen
            {...common}
            band={{
                label: t('welcome.label'),
                figure: t('welcome.figure'),
                unit: t('welcome.unit'),
                note: t('welcome.note'),
            }}
            action={
                <button
                    type="button"
                    className={button.inverse}
                    disabled={pending !== null}
                    aria-busy={pending !== null || undefined}
                    onClick={connectOne}
                >
                    {pending ??
                        (wallets.length === 1 ? t('connect.one', { wallet: wallets[0].name }) : t('connect.any'))}
                </button>
            }
            seal={noPermission}
        >
            <WalletLayer ref={layer} wallets={wallets} onChoose={choose} />
            {failed && pending === null ? (
                <Notice>
                    {isUserRejection(connect.error)
                        ? t('errors.rejected', { wallet: failed })
                        : t('errors.failed', { wallet: failed })}
                </Notice>
            ) : null}
            <Rows>
                <Row label={t('welcome.custody')} value={t('welcome.custodyValue')} />
                <Row label={t('welcome.signatures')} value={t('welcome.signaturesValue')} />
                <Row label={t('welcome.exit')} value={t('welcome.exitValue')} />
            </Rows>
        </Screen>
    );
}
