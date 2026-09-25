'use client';

import { type Address, getBase58Decoder } from '@solana/kit';
import { useAction } from '@solana/react';
import { useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { button } from '@laterite/ui/button';
import { DECLARATION_STATEMENTS, declarationMessage } from '@/lib/declaration';
import { client, isUserRejection } from '@/lib/solana';
import styles from './layers.module.css';
import { Notice } from './notice';

type DeclarationLayerProps = {
    wallet: Address;
    walletName: string;
    onDeclared: () => void;
    onDisconnect: () => void;
};

/**
 * The eligibility declaration: a layer that stays open until the wallet signs the declaration, which the server
 * checks and records, or disconnects. A signature, never a transaction.
 */
export function DeclarationLayer({ wallet, walletName, onDeclared, onDisconnect }: DeclarationLayerProps) {
    const t = useTranslations('app.declaration');
    const statement = useTranslations('declaration');
    const locale = useLocale();
    const layer = useRef<HTMLDialogElement>(null);
    useEffect(() => layer.current?.showModal(), []);

    const declare = useAction(async (signal: AbortSignal) => {
        const issuedAt = new Date().toISOString();
        const message = declarationMessage(statement, { domain: window.location.host, issuedAt, wallet });
        const signature = await client.wallet.signMessage(new TextEncoder().encode(message));
        const response = await fetch('/api/eligibility', {
            body: JSON.stringify({ issuedAt, locale, signature: getBase58Decoder().decode(signature), wallet }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
            signal,
        });
        if (!response.ok)
            throw Object.assign(new Error(`the declaration was refused: ${response.status}`), {
                status: response.status,
            });
        onDeclared();
    });
    const error = declare.error as { status?: number } | undefined;

    return (
        <dialog
            ref={layer}
            className={styles.layer}
            aria-labelledby="declaration-title"
            closedby="none"
            onCancel={event => event.preventDefault()}
        >
            <h2 id="declaration-title" className={styles.title}>
                {t('title')}
            </h2>
            <p className={styles.intro}>{t('intro')}</p>
            <ul className={styles.statements}>
                {DECLARATION_STATEMENTS.map(key => (
                    <li key={key}>{statement(key)}</li>
                ))}
            </ul>
            <p className={`${styles.receipt} mono`}>{t('note')}</p>
            {declare.status === 'error' ? (
                <Notice>
                    {isUserRejection(declare.error)
                        ? t('rejected')
                        : error?.status === 451
                          ? t('unavailable')
                          : t('failed')}
                </Notice>
            ) : null}
            <div className={styles.actions}>
                <button
                    type="button"
                    className={`${button.primary} ${styles.sign}`}
                    disabled={declare.isRunning}
                    onClick={() => declare.dispatch()}
                >
                    {declare.isRunning ? t('signing', { wallet: walletName }) : t('sign')}
                </button>
                <button type="button" className={`${button.outline} ${styles.choice} mono`} onClick={onDisconnect}>
                    {t('disconnect')}
                </button>
            </div>
        </dialog>
    );
}
