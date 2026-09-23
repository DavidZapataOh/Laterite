import { unwrapOption } from '@solana/kit';
import type { Mint } from '@solana-program/token-2022';

import type { Quote } from './pyth';

/**
 * The ScaledUiAmount multiplier a Token-2022 mint applies at `timestamp`: `newMultiplier` from its effective time on,
 * else `multiplier`, as Token-2022 converts amounts; 1 for a mint without the extension. UI amounts are raw amounts
 * times it over `10^decimals` (`amountToUiAmountForScaledUiAmountMintWithoutSimulation`).
 */
export function scaledUiAmountMultiplier(mint: Mint, timestamp: bigint): number {
    const config = unwrapOption(mint.extensions)?.find(extension => extension.__kind === 'ScaledUiAmountConfig');
    if (!config) return 1;
    return timestamp >= config.newMultiplierEffectiveTimestamp ? config.newMultiplier : config.multiplier;
}

/**
 * The dollar price of one UI token from a Pyth Pro quote, which prices `10^decimals` raw units: the quote over the
 * multiplier in force.
 */
export function uiTokenPrice(quote: Quote, multiplier: number): number {
    return (Number(quote.price) * 10 ** quote.exponent) / multiplier;
}
