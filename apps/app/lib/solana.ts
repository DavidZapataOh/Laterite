import { createClient, devnet } from '@solana/kit';
import { solanaRpcConnection } from '@solana/kit-plugin-rpc';
import { walletIdentity, type WalletState } from '@solana/kit-plugin-wallet';

/** A Wallet Standard wallet as the wallet plugin discovers it. */
export type UiWallet = WalletState['wallets'][number];

/**
 * The wallets Laterite supports, with each one's link that opens a page inside its own browser
 * (https://docs.phantom.com/phantom-deeplinks/other-methods/browse and the Solflare and Backpack equivalents).
 */
export const WALLETS = [
    { name: 'Phantom', browse: 'https://phantom.app/ul/browse/' },
    { name: 'Solflare', browse: 'https://solflare.com/ul/v1/browse/' },
    { name: 'Backpack', browse: 'https://backpack.app/ul/v1/browse/' },
] as const;

/** The link that opens `page` inside `wallet`'s own browser, or its site where the app is not installed. */
export function browseLink(wallet: (typeof WALLETS)[number], page: URL): string {
    return `${wallet.browse}${encodeURIComponent(page.href)}?ref=${encodeURIComponent(page.origin)}`;
}

const supported = new Set<string>(WALLETS.map(wallet => wallet.name));

/**
 * The app's one Kit client: devnet reads, and the connected wallet as the user's identity. Laterite's sponsor pays
 * every fee, so the wallet never becomes the payer.
 */
export const client = createClient()
    .use(
        walletIdentity({
            chain: 'solana:devnet',
            filter: wallet => supported.has(wallet.name) && wallet.features.includes('solana:signMessage'),
        }),
    )
    .use(
        solanaRpcConnection({
            rpcUrl: devnet(process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'),
        }),
    );

/** A wallet's address as the chip shows it: the first and last four characters. */
export function shortAddress(address: string): string {
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** True when a wallet refused a request because its user declined it (EIP-1193's 4001, which Solana wallets reuse). */
export function isUserRejection(error: unknown): boolean {
    if (!(error instanceof Object)) return false;
    const { code, message } = error as { code?: unknown; message?: unknown };
    return code === 4001 || (typeof message === 'string' && /reject|declin|denied|cancel/i.test(message));
}
