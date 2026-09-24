import { createServer } from 'node:http';

/**
 * Relays the fork's datasource requests to the mainnet RPC. Surfpool reuses a pooled connection the upstream has
 * silently dropped after an idle spell and waits 30 s on it; the relay keeps Surfpool's own connections open, opens
 * fresh ones upstream as needed, and retries a rate-limited, failed or stalled request with backoff, as a public
 * endpoint requires. It passes on reads only: a transaction or an airdrop request never reaches mainnet.
 */
const upstream = process.env.SURFPOOL_DATASOURCE_RPC_URL || 'https://api.mainnet-beta.solana.com';
const port = Number(process.argv[2] ?? 8897);
// Surfpool gives up on a request after 30 s, so the relay answers within 28.
const DEADLINE_MS = 28_000;
const ATTEMPT_TIMEOUT_MS = 10_000;

async function relay(body: string): Promise<{ body: Buffer; status: number }> {
    const deadline = Date.now() + DEADLINE_MS;
    for (let attempt = 0; ; attempt++) {
        const left = deadline - Date.now();
        try {
            const response = await fetch(upstream, {
                body,
                headers: { 'Content-Type': 'application/json' },
                method: 'POST',
                signal: AbortSignal.timeout(Math.min(left, ATTEMPT_TIMEOUT_MS)),
            });
            const answer = { body: Buffer.from(await response.arrayBuffer()), status: response.status };
            if (answer.status !== 429 && answer.status < 500) return answer;
            console.error(`Upstream answered ${answer.status} (attempt ${attempt + 1})`);
            if (deadline - Date.now() < 500 * 2 ** attempt) return answer;
        } catch (error) {
            console.error(`Upstream failed: ${(error as Error).name} (attempt ${attempt + 1})`);
            if (deadline - Date.now() < 500 * 2 ** attempt) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
}

/** What the fork must never pass on: it only reads mainnet. */
const REFUSED = new Set(['requestAirdrop', 'sendTransaction']);

/** The refusal of a request that would write to mainnet, or `null` for a read (or anything that is not JSON-RPC). */
function refusal(body: string): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return null;
    }
    const requests = [parsed as { id?: unknown; method?: string }].flat();
    if (!requests.some(request => REFUSED.has(request?.method ?? ''))) return null;
    const answers = requests.map(request => ({
        error: { code: -32601, message: 'The fork only reads its datasource' },
        id: request?.id ?? null,
        jsonrpc: '2.0',
    }));
    return JSON.stringify(Array.isArray(parsed) ? answers : answers[0]);
}

const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    const refused = refusal(body);
    if (refused) {
        console.error('Refused a write to the datasource');
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(refused);
        return;
    }
    try {
        const answer = await relay(body);
        response.writeHead(answer.status, { 'Content-Length': answer.body.length, 'Content-Type': 'application/json' });
        response.end(answer.body);
    } catch {
        response.writeHead(502).end();
    }
});
server.keepAliveTimeout = 0;
server.listen(port, '127.0.0.1', () => console.log(`Relaying the fork's datasource on port ${port}`));
