import { describe, expect, it } from 'vitest';

import { expectedAmountOut, poolPrice, repegAmountIn, repegOrder } from '../../src/repeg';

const fees = { tradeFeeRate: 2_500n, protocolFeeRate: 120_000n, fundFeeRate: 40_000n };
const decimals = { base: 8, quote: 6 };
const reserves = { base: 9_998_388_925n, quote: 77_412_550_419n };

describe('re-peg calculator', () => {
    it('reproduces the input that moved a real pool to its target', () => {
        expect(repegAmountIn(reserves.quote, reserves.base, (790 * 1e6) / 1e8, fees)).toBe(784_534_725n);
    });

    it('reads the pool price per whole base unit', () => {
        expect(poolPrice(reserves, decimals)).toBeCloseTo(774.2502417, 6);
    });

    it('buys the base when the pool is below the target', () => {
        expect(repegOrder(reserves, 790, decimals, fees)).toEqual({ side: 'buy', amountIn: 784_534_725n });
    });

    it('sells the base when the pool is above the target', () => {
        const order = repegOrder(reserves, 760, decimals, fees);
        expect(order?.side).toBe('sell');
        const quoteOut = expectedAmountOut(reserves.base, reserves.quote, order!.amountIn, fees);
        const after = poolPrice({ base: reserves.base + order!.amountIn, quote: reserves.quote - quoteOut }, decimals);
        expect(Math.abs(after / 760 - 1)).toBeLessThan(1e-4);
    });

    it('leaves a pool inside the tolerance alone', () => {
        expect(repegOrder(reserves, 775.9, decimals, fees, 25)).toBeNull();
    });
});
