import { fetchConfig, findConfigPda } from '@laterite/client';
import { JUPITER_PROGRAM_ADDRESS } from '@laterite/client/node';
import { ensureDeployment, JUPITER_ROUTE_MINTS, MARKET_CALENDAR_FILE, readMarketCalendar } from '@laterite/deployment';
import { MAINNET_MINTS } from '@laterite/devnet';
import { getBase58Decoder } from '@solana/kit';
import { fetchMint, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { describe, expect, it } from 'vitest';

import { forkConfigParams, forkContext } from './src/deployment';
import { DATASOURCE_RELAY_URL, rpc } from './src/fork';

const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

describe('mainnet fork', () => {
    it('keeps the SPYx extension set the product depends on', async () => {
        const mint = await fetchMint(rpc, MAINNET_MINTS.SPYx);
        expect(mint.programAddress).toBe(TOKEN_2022_PROGRAM_ADDRESS);
        const kinds = mint.data.extensions.__option === 'Some' ? mint.data.extensions.value.map(e => e.__kind) : [];
        expect(kinds).toEqual(
            expect.arrayContaining([
                'DefaultAccountState',
                'PausableConfig',
                'PermanentDelegate',
                'ScaledUiAmountConfig',
                'TransferHook',
            ]),
        );
    });

    it('only reads mainnet: the datasource relay refuses a transaction or an airdrop', async () => {
        for (const method of ['sendTransaction', 'requestAirdrop']) {
            const response = await fetch(DATASOURCE_RELAY_URL, {
                body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params: [] }),
                headers: { 'Content-Type': 'application/json' },
                method: 'POST',
            });
            expect(await response.json()).toMatchObject({ error: { code: -32601 } });
        }
    });

    it("deploys Laterite with Jupiter, the mainnet tables, mainnet's genesis hash and the fork's own keys", async () => {
        const { deployment, keys } = await forkContext();
        const { data: config } = await fetchConfig(rpc, (await findConfigPda())[0]);
        // Surfpool reports its upstream's genesis hash: only the fork's attestor key separates it from mainnet.
        expect(await rpc.getGenesisHash().send()).toBe(MAINNET_GENESIS_HASH);
        expect(getBase58Decoder().decode(config.genesisHash)).toBe(MAINNET_GENESIS_HASH);
        expect(config.router).toBe(JUPITER_PROGRAM_ADDRESS);
        expect(config.assets.map(({ mint }) => mint)).toEqual([MAINNET_MINTS.SPYx, MAINNET_MINTS.QQQx]);
        expect(config.paymentTokens.map(({ mint }) => mint)).toEqual([MAINNET_MINTS.USDC, MAINNET_MINTS.USDT]);
        expect([config.admin, config.attestor, config.sponsor]).toEqual([
            keys.authority.address,
            keys.attestor.address,
            keys.sponsor.address,
        ]);
        expect(config.marketCalendar.validThrough).toBeGreaterThan(0);
        expect(deployment.swapAccounts).toHaveLength(2 + JUPITER_ROUTE_MINTS.length);

        let sent = 0;
        const counting = { rpc, send: async () => (sent++, Promise.reject(new Error('nothing to send'))) };
        await ensureDeployment(counting, {
            authority: keys.authority,
            calendar: await readMarketCalendar(MARKET_CALENDAR_FILE),
            params: await forkConfigParams(keys),
            recorded: { lookupTable: deployment.lookupTable },
            routeMints: JUPITER_ROUTE_MINTS,
        });
        expect(sent).toBe(0);
    });
});
