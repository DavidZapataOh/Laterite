import { describe, expect, it } from 'vitest';

import { expectedAmountOut, poolPrice, REPEG_TOLERANCE_BPS, repegAmountIn, repegOrder } from '../../src/repeg';

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

    it('leaves a pool within 10 bps of the target alone and re-pegs one past it', () => {
        const price = poolPrice(reserves, decimals);
        expect(REPEG_TOLERANCE_BPS).toBe(10);
        expect(repegOrder(reserves, price / 1.00099, decimals, fees)).toBeNull();
        expect(repegOrder(reserves, price * 1.00099, decimals, fees)).toBeNull();
        expect(repegOrder(reserves, price / 1.0011, decimals, fees)?.side).toBe('sell');
        expect(repegOrder(reserves, price * 1.0011, decimals, fees)?.side).toBe('buy');
    });

    it("keeps a $25 buy at the band's dear edge within 40 bps of the target", () => {
        const target = poolPrice(reserves, decimals) / (1 + REPEG_TOLERANCE_BPS / 10_000);
        const out = expectedAmountOut(reserves.quote, reserves.base, 25_000_000n, fees);
        const cost = (1 - ((Number(out) / 1e8) * target) / 25) * 10_000;
        expect(cost).toBeGreaterThan(35);
        expect(cost).toBeLessThan(40);
    });
});
