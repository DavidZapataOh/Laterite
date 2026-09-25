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
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { button } from '@laterite/ui/button';
import { readAccount } from '@/lib/account';
import { client, isUserRejection, type UiWallet } from '@/lib/solana';
import { BarChips } from './chips';
import { Dashboard } from './dashboard';
import { DeclarationLayer } from './declaration-layer';
import { Notice } from './notice';
import { type Draft, Onboarding, type Review } from './onboarding';
import { Permission } from './permission';
import { type BandProps, Row, Rows, Screen } from './screen';
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
    const status = useWalletStatus(client);
    const wallets = useWallets(client);
    const connected = useConnectedWallet(client);
    const connect = useConnect(client);
    const disconnect = useDisconnect(client);
    const layer = useRef<HTMLDialogElement>(null);
    const [chosen, setChosen] = useState<UiWallet | null>(null);
    // what the wallet chose to sign, which the permission screen opens on, and its choices for the way back
    const [review, setReview] = useState<Review | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);

    const address = connected?.account.address as Address | undefined;
    const account = useRequest(
        useMemo(() => (address ? (signal: AbortSignal) => readAccount(client.rpc, address, signal) : null), [address]),
    );
    const eligibility = useRequest(
        useMemo(() => (address ? (signal: AbortSignal) => readEligibility(address, signal) : null), [address]),
    );

    const refreshAccount = account.refresh;
    const signed = useCallback(() => {
        setReview(null);
        setDraft(null);
        refreshAccount();
    }, [refreshAccount]);

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
        const notices = (
            <>
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
            </>
        );
        if (state?.kind === 'new' || state?.kind === 'exited') {
            const returning = state.kind === 'exited' ? state.config : null;
            return review ? (
                <Permission
                    key={address}
                    common={common}
                    wallet={address}
                    review={review}
                    account={returning}
                    notices={notices}
                    onBack={() => setReview(null)}
                    onSigned={signed}
                />
            ) : (
                <Onboarding
                    key={address}
                    common={common}
                    wallet={address}
                    account={returning}
                    notices={notices}
                    draft={draft}
                    onReview={next => {
                        setDraft(next.draft);
                        setReview(next);
                    }}
                />
            );
        }
        if (state?.kind === 'enrolled') {
            return <Dashboard common={common} wallet={address} user={state.config} notices={notices} />;
        }
        const band: BandProps = { label: t('account.reading'), figure: '—', busy: true };
        const seal = noPermission;
        return (
            <Screen {...common} band={band} seal={seal}>
                {notices}
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
