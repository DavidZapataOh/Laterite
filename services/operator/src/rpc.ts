import { setTimeout as sleep } from 'node:timers/promises';

import {
    createDefaultRpcTransport,
    createSolanaRpcFromTransport,
    isSolanaError,
    type Rpc,
    type RpcTransport,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
    type SolanaRpcApi,
} from '@solana/kit';

/** How long one endpoint may take to answer before the next one is asked. */
export const RPC_TIMEOUT_MS = 10_000;
/** Retries of a request an endpoint rate-limits (429), a second apart and doubling, before the next one is asked. */
const RATE_LIMIT_RETRIES = 5;
/**
 * Methods whose `null` result can mean only that this endpoint lacks the data yet: a private endpoint was seen answering
 * `null` for a transaction seconds old, so the next endpoint is asked before `null` is believed.
 */
const NULL_ASKS_NEXT = new Set(['getTransaction']);

const rateLimited = (error: unknown) =>
    isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && error.context.statusCode === 429;

/**
 * An RPC client over `urls` in order, as Kit's failover transport: a request an endpoint fails, or answers later than
 * {@link RPC_TIMEOUT_MS}, goes to the next one, after waiting out the endpoint's rate limit a few times; it fails only
 * when every endpoint has. A `getTransaction` one endpoint answers with `null` is asked of the next as well.
 */
export function createFailoverRpc(urls: readonly string[], timeoutMs = RPC_TIMEOUT_MS): Rpc<SolanaRpcApi> {
    const transports = urls.map(url => createDefaultRpcTransport({ url }));
    const failover = async <TResponse>(...[config]: Parameters<RpcTransport>): Promise<TResponse> => {
        const asksNext = NULL_ASKS_NEXT.has((config.payload as { method?: string }).method ?? '');
        let lastError: unknown;
        let nullResponse: TResponse | undefined;
        for (const transport of transports) {
            for (let attempt = 0; ; attempt++) {
                const timeout = AbortSignal.timeout(timeoutMs);
                try {
                    const response = await transport<TResponse>({
                        ...config,
                        signal: config.signal ? AbortSignal.any([config.signal, timeout]) : timeout,
                    });
                    if (!asksNext || (response as { result?: unknown }).result !== null) return response;
                    nullResponse = response;
                    break;
                } catch (error) {
                    if (config.signal?.aborted) throw error;
                    lastError = error;
                    if (!rateLimited(error) || attempt === RATE_LIMIT_RETRIES) break;
                    await sleep(1_000 * 2 ** attempt, undefined, { signal: config.signal });
                }
            }
        }
        if (nullResponse !== undefined) return nullResponse;
        throw lastError;
    };
    return createSolanaRpcFromTransport(failover as RpcTransport);
}
