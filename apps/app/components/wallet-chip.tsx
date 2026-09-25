'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { button } from '@laterite/ui/button';
import { chip } from '@laterite/ui/chip';
import { shortAddress } from '@/lib/solana';
import chips from './chips.module.css';
import styles from './layers.module.css';

/** The connected wallet's chip; it opens a small layer with the full address, copy and disconnect. */
export function WalletChip({ address, onDisconnect }: { address: string; onDisconnect: () => void }) {
    const t = useTranslations('app.bar');
    const [copied, setCopied] = useState(false);
    return (
        <li>
            <button
                type="button"
                popoverTarget="wallet-menu"
                aria-label={t('wallet', { address: shortAddress(address) })}
                className={`${chip} ${chips.chip} ${chips.link} mono ${chips.address}`}
            >
                {shortAddress(address)}
            </button>
            <div id="wallet-menu" popover="auto" className={styles.menu}>
                <p className={`${styles.address} mono`}>{address}</p>
                <div className={styles.menuActions}>
                    <button
                        type="button"
                        className={`${button.outline} ${styles.menuButton} mono`}
                        onClick={() => navigator.clipboard.writeText(address).then(() => setCopied(true))}
                    >
                        {copied ? t('copied') : t('copy')}
                    </button>
                    <button
                        type="button"
                        popoverTarget="wallet-menu"
                        popoverTargetAction="hide"
                        className={`${button.outline} ${styles.menuButton} mono`}
                        onClick={onDisconnect}
                    >
                        {t('disconnect')}
                    </button>
                </div>
            </div>
        </li>
    );
}
