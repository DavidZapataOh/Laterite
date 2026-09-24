import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createFailoverRpc } from '../src/rpc';

const servers: Server[] = [];

/** A JSON-RPC endpoint answering each request with `answer`'s status and `getSlot` result, counting requests. */
async function endpoint(answer: (request: number) => { delayMs?: number; slot?: number; status: number }) {
    let requests = 0;
    const server = createServer((request, response) => {
        const { delayMs = 0, slot, status } = answer(requests++);
        request.resume();
        request.on('end', () =>
            setTimeout(
                () => response.writeHead(status).end(JSON.stringify({ id: 0, jsonrpc: '2.0', result: slot })),
                delayMs,
            ),
        );
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { requests: () => requests, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

describe('the failover RPC', () => {
    it('asks the next endpoint when one fails', async () => {
        const [down, up] = await Promise.all([
            endpoint(() => ({ status: 503 })),
            endpoint(() => ({ slot: 7, status: 200 })),
        ]);
        expect(await createFailoverRpc([down.url, up.url]).getSlot().send()).toBe(7n);
        expect([down.requests(), up.requests()]).toEqual([1, 1]);
    });

    it('asks the next endpoint when one does not answer in time', async () => {
        const [stalled, up] = await Promise.all([
            endpoint(() => ({ delayMs: 2_000, slot: 1, status: 200 })),
            endpoint(() => ({ slot: 8, status: 200 })),
        ]);
        expect(await createFailoverRpc([stalled.url, up.url], 200).getSlot().send()).toBe(8n);
    });

    it("waits out an endpoint's rate limit before asking the next one", async () => {
        const [limited, spare] = await Promise.all([
            endpoint(request => (request === 0 ? { status: 429 } : { slot: 9, status: 200 })),
            endpoint(() => ({ slot: 10, status: 200 })),
        ]);
        expect(await createFailoverRpc([limited.url, spare.url]).getSlot().send()).toBe(9n);
        expect([limited.requests(), spare.requests()]).toEqual([2, 0]);
    });

    it('fails when every endpoint has', async () => {
        const [a, b] = await Promise.all([endpoint(() => ({ status: 500 })), endpoint(() => ({ status: 502 }))]);
        await expect(createFailoverRpc([a.url, b.url]).getSlot().send()).rejects.toThrow('502');
    });
});
