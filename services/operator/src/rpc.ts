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

const rateLimited = (error: unknown) =>
    isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && error.context.statusCode === 429;

/**
 * An RPC client over `urls` in order, as Kit's failover transport: a request an endpoint fails, or answers later than
 * {@link RPC_TIMEOUT_MS}, goes to the next one, after waiting out the endpoint's rate limit a few times; it fails only
 * when every endpoint has.
 */
export function createFailoverRpc(urls: readonly string[], timeoutMs = RPC_TIMEOUT_MS): Rpc<SolanaRpcApi> {
    const transports = urls.map(url => createDefaultRpcTransport({ url }));
    const failover = async <TResponse>(...[config]: Parameters<RpcTransport>): Promise<TResponse> => {
        let lastError: unknown;
        for (const transport of transports) {
            for (let attempt = 0; ; attempt++) {
                const timeout = AbortSignal.timeout(timeoutMs);
                try {
                    return await transport<TResponse>({
                        ...config,
                        signal: config.signal ? AbortSignal.any([config.signal, timeout]) : timeout,
                    });
                } catch (error) {
                    if (config.signal?.aborted) throw error;
                    lastError = error;
                    if (!rateLimited(error) || attempt === RATE_LIMIT_RETRIES) break;
                    await sleep(1_000 * 2 ** attempt, undefined, { signal: config.signal });
                }
            }
        }
        throw lastError;
    };
    return createSolanaRpcFromTransport(failover as RpcTransport);
}
