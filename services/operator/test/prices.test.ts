import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { decodePythStorage, feedUpdatedAt } from '@laterite/client';
import { getPythUpdateFromTransaction } from '@laterite/client/node';
import { getBase16Encoder, getBase64Encoder, type Signature } from '@solana/kit';
import { afterEach, describe, expect, it } from 'vitest';

import { KaminoRelay, PythProUpdates } from '../src/crank/prices';
import { createLogger } from '../src/log';
import { createFailoverRpc } from '../src/rpc';

const recorded = <T>(name: string): T => JSON.parse(readFileSync(new URL(`recorded/${name}`, import.meta.url), 'utf8'));
const log = createLogger('silent');

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

/** A mainnet endpoint that answers recorded responses, or `null` for `getTransaction`, or late. */
async function mainnet({ delayMs = 0, nullTransactions = false } = {}) {
    const exchanges = recorded<{ method: string; params: unknown[]; result: unknown }[]>('kamino-rpc.json');
    let transactions = 0;
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', chunk => (body += chunk));
        request.on('end', () => {
            const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
            if (method === 'getTransaction') transactions += 1;
            const exchange = exchanges.find(e => e.method === method && e.params[0] === params[0]);
            const result = method === 'getTransaction' && nullTransactions ? null : (exchange?.result ?? null);
            setTimeout(() => response.end(JSON.stringify({ id, jsonrpc: '2.0', result })), delayMs);
        });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { transactions: () => transactions, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** The update of the recorded Kamino Scope post. */
async function kaminoPost() {
    const exchanges = recorded<{ method: string; result: { transaction: [string, 'base64'] } }[]>('kamino-rpc.json');
    const { transaction } = exchanges.find(({ method }) => method === 'getTransaction')!.result;
    return getPythUpdateFromTransaction(getBase64Encoder().encode(transaction[0]))!;
}

describe('the Kamino Scope relay', () => {
    const post = 'jjymaDw2eVwt1ncPDtApNNDMbB9AMNBpGBZZF4JcHzym2ipCoxUX2sfry6dDWudqHaP27JWTcvbCLNzwJcKpCT7' as Signature;
    const fixture = new URL('../../../programs/laterite/tests/fixtures/pyth_storage_devnet.bin', import.meta.url);
    const storage = async () => decodePythStorage(new Uint8Array(readFileSync(fixture)));
    const relay = (url: string[], timeoutMs?: number, waitMs?: number) =>
        new KaminoRelay({ feedIds: [1843, 1837], log, mainnet: createFailoverRpc(url, timeoutMs), storage, waitMs });

    it('asks the fallback provider for a post the primary returns as null, and keeps its checked update', async () => {
        const [primary, fallback] = await Promise.all([mainnet({ nullTransactions: true }), mainnet()]);
        const kamino = relay([primary.url, fallback.url]);
        await kamino.ingest(post);
        expect([primary.transactions(), fallback.transactions()]).toEqual([1, 1]);
        const spyx = kamino.updates().get(1843)!;
        expect(spyx.message).toHaveLength(548);
        expect(spyx.updatedAt).toBe(feedUpdatedAt(spyx.message, 1843));
        expect(kamino.updates().get(1837)?.message).toBe(spyx.message);
    });

    it('asks the fallback provider when the primary does not answer in time', async () => {
        const [stalled, fallback] = await Promise.all([mainnet({ delayMs: 2_000 }), mainnet()]);
        const kamino = relay([stalled.url, fallback.url], 200);
        await kamino.ingest(post);
        expect(kamino.updates().get(1843)?.message).toHaveLength(548);
    });

    it('polls Scope for a sweep while it holds no fresh update, and gives up after the wait', async () => {
        const endpoint = await mainnet();
        const kamino = relay([endpoint.url], undefined, 800);
        const updatedAt = feedUpdatedAt(await kaminoPost(), 1843)!;
        // Nothing held yet: the sweep's wait polls Scope's recent signatures and finds the post.
        const fresh = await kamino.asset(1843, updatedAt + 45n);
        expect(fresh?.updatedAt).toBe(updatedAt);
        expect(endpoint.transactions()).toBe(1);
        // One second too old: the poll finds nothing newer and the wait ends empty.
        expect(await kamino.asset(1843, updatedAt + 46n)).toBeNull();
    });

    it('keeps no update its cluster does not trust', async () => {
        const endpoint = await mainnet();
        const untrusting = new KaminoRelay({
            feedIds: [1843],
            log,
            mainnet: createFailoverRpc([endpoint.url]),
            storage: async () => ({ ...(await storage()), trustedSigners: [] }),
        });
        await expect(untrusting.ingest(post)).rejects.toThrow('does not trust');
        expect(untrusting.updates().size).toBe(0);
    });
});

describe('the USDT updates', () => {
    it('fetches one with the access token and reuses it for 20 s of its time', async () => {
        const { body } = recorded<{ '200': { body: string } }>('pyth-pro.json')['200'];
        let requests = 0;
        const fetch = (async (_url: string, init?: RequestInit) => {
            requests += 1;
            expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
            return new Response(body, { status: 200 });
        }) as typeof globalThis.fetch;
        const fixture = new URL('../../../programs/laterite/tests/fixtures/pyth_storage_devnet.bin', import.meta.url);
        const updates = new PythProUpdates({
            accessToken: 'secret-token',
            fetch,
            storage: async () => decodePythStorage(new Uint8Array(readFileSync(fixture))),
        });
        const data = (JSON.parse(body) as { solana: { data: string } }).solana.data;
        const updatedAt = feedUpdatedAt(getBase16Encoder().encode(data), 8)!;
        const first = await updates.payment(8, updatedAt + 1n);
        expect(await updates.payment(8, updatedAt + 20n)).toBe(first);
        expect(requests).toBe(1);
        await updates.payment(8, updatedAt + 21n);
        expect(requests).toBe(2);
    });
});
