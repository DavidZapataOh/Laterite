import { beforeAll, describe, expect, it } from 'vitest';

import { addresses } from '../../src/addresses';
import { POOL_FEES, poolReserves, swapInstruction } from '../../src/cpmm';
import { fetchAmmConfig } from '../../src/generated';
import { fetchUsdPrices, poolTargets } from '../../src/prices';
import { poolPrice, repeg } from '../../src/repeg';
import { client, keys } from './context';

const pool = addresses.pools['SPYx-USDC'];
const decimals = { base: 8, quote: 6 };
const price = async () => poolPrice(await poolReserves(client.rpc, pool, addresses.tokens), decimals);

describe('re-peg', () => {
    let target: number;

    beforeAll(async () => {
        target = poolTargets(await fetchUsdPrices())['SPYx-USDC'];
        await repeg({
            addresses,
            client,
            maxDeviationBps: 10_000,
            pool: 'SPYx-USDC',
            targetPrice: target,
            treasury: keys.treasury,
        });
    });

    it('returns a pushed pool to the target in one swap', async () => {
        const reserves = await poolReserves(client.rpc, pool, addresses.tokens);
        await client.send(
            keys.treasury,
            await swapInstruction({
                amountIn: reserves.quote / 200n,
                ammConfig: addresses.cpmm.ammConfig,
                minimumAmountOut: 1n,
                owner: keys.treasury,
                payer: keys.treasury,
                pool,
                side: 'buy',
                tokens: addresses.tokens,
            }),
        );
        expect(Math.abs((await price()) / target - 1) * 10_000).toBeGreaterThan(25);

        expect(
            await repeg({ addresses, client, pool: 'SPYx-USDC', targetPrice: target, treasury: keys.treasury }),
        ).not.toBeNull();
        expect(Math.abs((await price()) / target - 1) * 10_000).toBeLessThan(1);
    });

    it('does nothing inside the tolerance', async () => {
        expect(
            await repeg({ addresses, client, pool: 'SPYx-USDC', targetPrice: target, treasury: keys.treasury }),
        ).toBeNull();
    });

    it('refuses a target far from the pool', async () => {
        await expect(
            repeg({ addresses, client, pool: 'SPYx-USDC', targetPrice: target * 1.2, treasury: keys.treasury }),
        ).rejects.toThrow('refusing');
    });

    it('computes with the fee rates of the deployed config', async () => {
        const { data } = await fetchAmmConfig(client.rpc, addresses.cpmm.ammConfig);
        expect({
            fundFeeRate: data.fundFeeRate,
            protocolFeeRate: data.protocolFeeRate,
            tradeFeeRate: data.tradeFeeRate,
        }).toEqual(POOL_FEES);
    });
});
