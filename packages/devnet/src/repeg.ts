import type { Signature, TransactionSigner } from '@solana/kit';

import type { DevnetAddresses } from './addresses';
import type { PoolName } from './assets';
import type { Client } from './client';
import { POOL_FEES, poolReserves, swapInstruction } from './cpmm';

const FEE_RATE_DENOMINATOR = 1_000_000;

/**
 * How far a pool may drift from its target before a re-peg, in basis points: with the pool's 25 bps fee, a $25 buy
 * at the band's dear edge costs under 40 bps, inside the sweep's 55 bps bound.
 */
export const REPEG_TOLERANCE_BPS = 10;

export type Reserves = { base: bigint; quote: bigint };
export type Decimals = { base: number; quote: number };
export type PoolFees = { tradeFeeRate: bigint; protocolFeeRate: bigint; fundFeeRate: bigint };
export type RepegOrder = { side: 'buy' | 'sell'; amountIn: bigint };

function feeShares(fees: PoolFees) {
    const f = Number(fees.tradeFeeRate) / FEE_RATE_DENOMINATOR;
    const s = Number(fees.protocolFeeRate + fees.fundFeeRate) / FEE_RATE_DENOMINATOR;
    return { kept: 1 - f * s, traded: 1 - f };
}

/** Pool price in quote per whole base unit. */
export function poolPrice(reserves: Reserves, decimals: Decimals): number {
    return Number(reserves.quote) / 10 ** decimals.quote / (Number(reserves.base) / 10 ** decimals.base);
}

/** Exact input that moves a constant-product pool with reserves `x` (in) and `y` (out) to `targetInPerOut` atoms. */
export function repegAmountIn(x: bigint, y: bigint, targetInPerOut: number, fees: PoolFees): bigint {
    const { kept, traded } = feeShares(fees);
    const xIn = Number(x);
    const a = kept * traded;
    const b = xIn * (kept + traded);
    const c = xIn * xIn - targetInPerOut * xIn * Number(y);
    return BigInt(Math.round((-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a)));
}

/** Output of a constant-product swap after the trade fee. */
export function expectedAmountOut(x: bigint, y: bigint, amountIn: bigint, fees: PoolFees): bigint {
    const net = (amountIn * (BigInt(FEE_RATE_DENOMINATOR) - fees.tradeFeeRate)) / BigInt(FEE_RATE_DENOMINATOR);
    return (y * net) / (x + net);
}

/** The swap that returns a pool to `targetPrice` (quote per whole base unit), or null inside the tolerance. */
export function repegOrder(
    reserves: Reserves,
    targetPrice: number,
    decimals: Decimals,
    fees: PoolFees,
    toleranceBps = REPEG_TOLERANCE_BPS,
): RepegOrder | null {
    const price = poolPrice(reserves, decimals);
    if (Math.abs(price / targetPrice - 1) * 10_000 <= toleranceBps) return null;
    const quotePerBaseAtom = (targetPrice * 10 ** decimals.quote) / 10 ** decimals.base;
    return price < targetPrice
        ? { amountIn: repegAmountIn(reserves.quote, reserves.base, quotePerBaseAtom, fees), side: 'buy' }
        : { amountIn: repegAmountIn(reserves.base, reserves.quote, 1 / quotePerBaseAtom, fees), side: 'sell' };
}

/** Swaps from the treasury until `pool` sits at `targetPrice` (quote per whole base unit, raw units). */
export async function repeg(p: {
    client: Client;
    treasury: TransactionSigner;
    addresses: DevnetAddresses;
    pool: PoolName;
    targetPrice: number;
    toleranceBps?: number;
    maxDeviationBps?: number;
}): Promise<Signature | null> {
    const pool = p.addresses.pools[p.pool];
    const decimals = { base: p.addresses.tokens[pool.base].decimals, quote: p.addresses.tokens[pool.quote].decimals };
    const reserves = await poolReserves(p.client.rpc, pool, p.addresses.tokens);
    const deviationBps = Math.abs(poolPrice(reserves, decimals) / p.targetPrice - 1) * 10_000;
    if (deviationBps > (p.maxDeviationBps ?? 500)) {
        throw new Error(`${p.pool} is ${deviationBps.toFixed(0)} bps from ${p.targetPrice}; refusing to re-peg`);
    }
    const order = repegOrder(reserves, p.targetPrice, decimals, POOL_FEES, p.toleranceBps);
    if (!order) return null;
    const [x, y] = order.side === 'buy' ? [reserves.quote, reserves.base] : [reserves.base, reserves.quote];
    const out = expectedAmountOut(x, y, order.amountIn, POOL_FEES);
    return await p.client.send(
        p.treasury,
        await swapInstruction({
            amountIn: order.amountIn,
            ammConfig: p.addresses.cpmm.ammConfig,
            minimumAmountOut: (out * 99n) / 100n,
            owner: p.treasury,
            payer: p.treasury,
            pool,
            side: order.side,
            tokens: p.addresses.tokens,
        }),
    );
}
