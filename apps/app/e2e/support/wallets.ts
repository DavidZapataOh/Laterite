import type { JsonWebKey } from 'node:crypto';

import type { Page } from '@playwright/test';

import type { TestKey } from './keys';

export type TestWallet = {
    /** The Wallet Standard name the app looks for: Phantom, Solflare or Backpack. */
    name: string;
    key: TestKey;
    /** Decline every connection, as a user who closes the prompt does. */
    rejectConnect?: boolean;
    /** Hold every connection until the test calls `window.approve()`. */
    holdConnect?: boolean;
    /** Decline every message signature. */
    rejectSign?: boolean;
    /** Sign a message other than the one asked for, as a tampered wallet would. */
    signOther?: boolean;
};

type Injected = Omit<TestWallet, 'key'> & { address: string; jwk: JsonWebKey };

/**
 * Registers Wallet Standard wallets in the page before any script runs, as a wallet extension or an in-app browser
 * does: each connects to its key's account on devnet and signs messages with it through WebCrypto's Ed25519. Test
 * doubles of the real wallets; they sign no transaction.
 */
export async function installWallets(page: Page, wallets: TestWallet[]) {
    const injected: Injected[] = wallets.map(({ key, ...wallet }) => ({
        ...wallet,
        address: key.address,
        jwk: key.jwk,
    }));
    await page.addInitScript((wallets: Injected[]) => {
        const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        const decode58 = (text: string) => {
            let value = 0n;
            for (const char of text) value = value * 58n + BigInt(alphabet.indexOf(char));
            const bytes = new Uint8Array(32);
            for (let index = 31; index >= 0; index--, value >>= 8n) bytes[index] = Number(value & 0xffn);
            return bytes;
        };
        const icon = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=' as const;
        let release: () => void = () => {};
        (window as unknown as { approve: () => void }).approve = () => release();

        for (const test of wallets) {
            const account = {
                address: test.address,
                chains: ['solana:devnet'] as const,
                features: ['solana:signMessage', 'solana:signTransaction'] as const,
                publicKey: decode58(test.address),
            };
            const key = crypto.subtle.importKey('jwk', test.jwk as JsonWebKey, { name: 'Ed25519' }, false, ['sign']);
            let accounts: (typeof account)[] = [];
            const listeners = new Set<(properties: { accounts: typeof accounts }) => void>();
            const rejected = () => Object.assign(new Error('User rejected the request.'), { code: 4001 });
            const wallet = {
                get accounts() {
                    return accounts;
                },
                chains: ['solana:devnet'],
                features: {
                    'solana:signMessage': {
                        signMessage: async (...inputs: { message: Uint8Array }[]) => {
                            if (test.rejectSign) throw rejected();
                            return Promise.all(
                                inputs.map(async ({ message }) => ({
                                    signature: new Uint8Array(
                                        await crypto.subtle.sign(
                                            'Ed25519',
                                            await key,
                                            (test.signOther
                                                ? message.map((byte, i) => (i ? byte : byte ^ 1))
                                                : message) as BufferSource,
                                        ),
                                    ),
                                    signedMessage: message,
                                })),
                            );
                        },
                        version: '1.1.0',
                    },
                    'solana:signTransaction': {
                        signTransaction: async () => {
                            throw new Error('The test wallet signs no transaction.');
                        },
                        supportedTransactionVersions: ['legacy', 0],
                        version: '1.0.0',
                    },
                    'standard:connect': {
                        connect: async () => {
                            if (test.holdConnect) await new Promise<void>(resolve => (release = resolve));
                            if (test.rejectConnect) throw rejected();
                            accounts = [account];
                            listeners.forEach(listener => listener({ accounts }));
                            return { accounts };
                        },
                        version: '1.0.0',
                    },
                    'standard:disconnect': {
                        disconnect: async () => {
                            accounts = [];
                            listeners.forEach(listener => listener({ accounts }));
                        },
                        version: '1.0.0',
                    },
                    'standard:events': {
                        on: (_event: 'change', listener: (properties: { accounts: typeof accounts }) => void) => {
                            listeners.add(listener);
                            return () => listeners.delete(listener);
                        },
                        version: '1.0.0',
                    },
                },
                icon,
                name: test.name,
                version: '1.0.0',
            };
            const register = ({ register }: { register: (wallet: unknown) => void }) => register(wallet);
            window.addEventListener('wallet-standard:app-ready', event =>
                register((event as CustomEvent).detail as Parameters<typeof register>[0]),
            );
            window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
        }
    }, injected);
}
