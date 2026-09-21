import { address, type Address } from '@solana/kit';

export const STABLES = ['USDC', 'USDT'] as const;
export const XSTOCKS = ['SPYx', 'QQQx'] as const;

export type Stable = (typeof STABLES)[number];
export type XStock = (typeof XSTOCKS)[number];
export type TokenSymbol = Stable | XStock;
export type PoolName = `${XStock}-${Stable}`;

export const POOLS = XSTOCKS.flatMap(base => STABLES.map(quote => ({ base, quote })));

export const poolName = (base: XStock, quote: Stable): PoolName => `${base}-${quote}`;

export const DECIMALS: Record<TokenSymbol, number> = { QQQx: 8, SPYx: 8, USDC: 6, USDT: 6 };

export const MAINNET_MINTS: Record<TokenSymbol, Address> = {
    QQQx: address('Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ'),
    SPYx: address('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W'),
    USDC: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    USDT: address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
};

/** Pyth price feeds: Core feed id and Pro (Lazer) id. SPYX and QQQX are quoted per raw token unit. */
export const PYTH_FEEDS = {
    QQQx: { feedId: '178a6f73a5aede9d0d682e86b0047c9f333ed0efe5c6537ca937565219c4054d', proId: 1837 },
    SPYx: { feedId: '2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14', proId: 1843 },
    USDT: { feedId: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b', proId: 8 },
} as const;
