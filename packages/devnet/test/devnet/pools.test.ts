import { generateKeyPairSigner } from '@solana/kit';
import { fetchPoolState } from '../../src/generated';
import { beforeAll, describe, expect, it } from 'vitest';

import { addresses } from '../../src/addresses';
import { POOLS, poolName } from '../../src/assets';
import { poolReserves, swapInstruction } from '../../src/cpmm';
import { mintToInstructions, tokenBalance } from '../../src/mints';
import { fetchUsdPrices, poolTargets } from '../../src/prices';
import { poolPrice } from '../../src/repeg';
import { ensureAssets } from '../../src/setup';
import { client, keys, mainnetRpc } from './context';

const decimals = (base: 'SPYx' | 'QQQx', quote: 'USDC' | 'USDT') => ({
    base: addresses.tokens[base].decimals,
    quote: addresses.tokens[quote].decimals,
});

describe('devnet pools', () => {
    let targets: Awaited<ReturnType<typeof poolTargets>>;

    beforeAll(async () => {
        targets = poolTargets(await fetchUsdPrices());
    });

    it.each(POOLS)('$base/$quote holds liquidity on our CPMM', async ({ base, quote }) => {
        const pool = addresses.pools[poolName(base, quote)];
        const state = await fetchPoolState(client.rpc, pool.address);
        expect(state.programAddress).toBe(addresses.cpmm.program);
        const reserves = await poolReserves(client.rpc, pool, addresses.tokens);
        expect(reserves.base).toBeGreaterThan(0n);
        expect(reserves.quote).toBeGreaterThan(0n);
    });

    it.each(POOLS)('a fresh wallet swaps 25 $quote into $base at the pool price', async ({ base, quote }) => {
        const pool = addresses.pools[poolName(base, quote)];
        const wallet = await generateKeyPairSigner();
        const quoteToken = addresses.tokens[quote];
        const baseToken = addresses.tokens[base];
        await client.send(
            keys.issuer,
            await mintToInstructions({
                amount: 25_000_000n,
                authority: keys.faucet,
                decimals: 6,
                mint: quoteToken.mint,
                owner: wallet.address,
                payer: keys.issuer,
                tokenProgram: quoteToken.tokenProgram,
            }),
        );
        const spot = poolPrice(await poolReserves(client.rpc, pool, addresses.tokens), decimals(base, quote));

        await client.send(keys.issuer, [
            ...(await swapInstruction({
                amountIn: 25_000_000n,
                ammConfig: addresses.cpmm.ammConfig,
                minimumAmountOut: 1n,
                owner: wallet,
                payer: keys.issuer,
                pool,
                side: 'buy',
                tokens: addresses.tokens,
            })),
        ]);

        const received = await tokenBalance(client.rpc, wallet.address, baseToken.mint, baseToken.tokenProgram);
        const effective = 25 / (Number(received) / 10 ** baseToken.decimals);
        expect(effective / spot - 1).toBeGreaterThan(0.0025);
        expect(effective / spot - 1).toBeLessThan(0.01);
    });

    it('rerunning the setup sends nothing', async () => {
        const before = client.sentCount();
        const again = await ensureAssets({ client, keys, mainnetRpc }, targets);
        expect(client.sentCount()).toBe(before);
        expect(again).toEqual(addresses);
    });
});
