'use client';

import type { RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { button } from '@laterite/ui/button';
import { useHydrated } from '@laterite/ui/use-hydrated';
import { browseLink, type UiWallet, WALLETS } from '@/lib/solana';
import styles from './layers.module.css';

type WalletLayerProps = {
    ref: RefObject<HTMLDialogElement | null>;
    /** The supported wallets this browser has. */
    wallets: readonly UiWallet[];
    onChoose: (wallet: UiWallet) => void;
};

/**
 * The layer that picks a wallet: each supported wallet this browser has connects; each it lacks opens this page
 * in that wallet's own browser.
 */
export function WalletLayer({ ref, wallets, onChoose }: WalletLayerProps) {
    const t = useTranslations('app.wallets');
    const hydrated = useHydrated();
    return (
        <dialog ref={ref} className={styles.layer} aria-labelledby="wallets-title" closedby="any">
            <h2 id="wallets-title" className={styles.title}>
                {t('title')}
            </h2>
            <p className={`${styles.receipt} mono`}>{t('note')}</p>
            <ul className={styles.choices}>
                {WALLETS.map(known => {
                    const found = wallets.find(wallet => wallet.name === known.name);
                    return (
                        <li key={known.name}>
                            {found ? (
                                <button
                                    type="button"
                                    className={`${button.outline} ${styles.choice} mono`}
                                    onClick={() => onChoose(found)}
                                >
                                    {known.name}
                                </button>
                            ) : (
                                <a
                                    className={`${button.outline} ${styles.choice} mono`}
                                    href={hydrated ? browseLink(known, new URL(window.location.href)) : known.browse}
                                >
                                    {t('open', { wallet: known.name })}
                                </a>
                            )}
                        </li>
                    );
                })}
            </ul>
            <form method="dialog">
                <button type="submit" className={`${button.outline} ${styles.close} mono`}>
                    {t('close')}
                </button>
            </form>
        </dialog>
    );
}
