import { createServer, type Server } from 'node:http';

import type { Logger } from './log';

/** One part of the service's health: `ok` and whatever explains it. */
export type Check = () => Promise<{ ok: boolean } & Record<string, unknown>>;

const CHECK_TIMEOUT_MS = 2_000;

async function run(check: Check) {
    try {
        return await Promise.race([
            check(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS)),
        ]);
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), ok: false };
    }
}

/**
 * Serves `GET /health` on `port` (every interface, IPv6 included, as Railway's private network needs): 200 when every
 * check passes, else 503, with each check's result as JSON. Railway gates each deploy on it.
 */
export function startHealthServer(port: number, checks: Record<string, Check>, log: Logger): Promise<Server> {
    const server = createServer(async (request, response) => {
        if (request.method !== 'GET' || request.url !== '/health') {
            response.writeHead(404).end();
            return;
        }
        const results = Object.fromEntries(
            await Promise.all(Object.entries(checks).map(async ([name, check]) => [name, await run(check)] as const)),
        );
        const ok = Object.values(results).every(result => result.ok);
        response
            .writeHead(ok ? 200 : 503, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' })
            .end(JSON.stringify({ status: ok ? 'ok' : 'failing', ...results }));
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '::', () => {
            log.info({ port }, 'health endpoint listening');
            resolve(server);
        });
    });
}
