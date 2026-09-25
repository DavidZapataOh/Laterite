import { createKeyPairSignerFromBytes, type KeyPairSigner, type MessagePartialSigner } from '@solana/kit';
import * as z from 'zod/mini';

const url = z.url({ protocol: /^https?$/ });
const wsUrl = z.url({ protocol: /^wss?$/ });

const keypair = z.pipe(
    z.string(),
    z.transform((value, context) => {
        try {
            const bytes = JSON.parse(value) as unknown;
            if (
                Array.isArray(bytes) &&
                bytes.length === 64 &&
                bytes.every(b => Number.isInteger(b) && b >= 0 && b < 256)
            ) {
                return new Uint8Array(bytes);
            }
        } catch {
            // Reported below without the value.
        }
        context.issues.push({ code: 'custom', input: '[secret]', message: 'expected a JSON array of 64 bytes' });
        return z.NEVER;
    }),
);

const schema = z.object({
    ATTESTOR_KEYPAIR: keypair,
    CRANK_KEYPAIR: keypair,
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    LOG_LEVEL: z._default(z.enum(['debug', 'info', 'warn', 'error']), 'info'),
    MAINNET_FALLBACK_RPC_URL: url,
    MAINNET_RPC_URL: url,
    OPS_TELEGRAM_BOT_TOKEN: z.string().check(z.regex(/^\d+:[\w-]{30,}$/)),
    OPS_TELEGRAM_CHAT_ID: z.string().check(z.regex(/^-?\d+$/)),
    PORT: z._default(z.coerce.number().check(z.int(), z.positive()), 8080),
    PYTH_PRO_ACCESS_TOKEN: z.string().check(z.minLength(1)),
    SOLANA_RPC_URL: url,
    SOLANA_WS_URL: z.optional(wsUrl),
});

/** The service's configuration, from the host's environment: Railway's variables and sealed secrets. */
export type Config = {
    /** Signs attestation messages only: it cannot sign a transaction. */
    attestor: MessagePartialSigner;
    crank: KeyPairSigner;
    databaseUrl: string;
    logLevel: 'debug' | 'error' | 'info' | 'warn';
    mainnetRpcUrls: [string, string];
    ops: { botToken: string; chatId: string };
    port: number;
    pythProAccessToken: string;
    rpcUrl: string;
    /** The RPC's WebSocket endpoint: `SOLANA_WS_URL`, else `SOLANA_RPC_URL` on `ws`/`wss`, as providers serve both. */
    rpcSubscriptionsUrl: string;
};

/** Thrown for a missing or malformed variable; names the variables, never their values. */
export class ConfigError extends Error {
    constructor(readonly variables: string[]) {
        super(`Missing or malformed environment variables: ${variables.join(', ')}`);
        this.name = 'ConfigError';
    }
}

/** Reads and checks every variable at once, so a deploy fails at start with the full list of what is wrong. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
        throw new ConfigError([...new Set(parsed.error.issues.map(issue => String(issue.path[0])))].sort());
    }
    const value = parsed.data;
    const [attestor, crank] = await Promise.all([
        createKeyPairSignerFromBytes(value.ATTESTOR_KEYPAIR),
        createKeyPairSignerFromBytes(value.CRANK_KEYPAIR),
    ]);
    // The attestor never pays or signs a transaction, so it must not be the crank.
    if (attestor.address === crank.address) throw new ConfigError(['ATTESTOR_KEYPAIR']);
    return {
        attestor: { address: attestor.address, signMessages: attestor.signMessages },
        crank,
        databaseUrl: value.DATABASE_URL,
        logLevel: value.LOG_LEVEL,
        mainnetRpcUrls: [value.MAINNET_RPC_URL, value.MAINNET_FALLBACK_RPC_URL],
        ops: { botToken: value.OPS_TELEGRAM_BOT_TOKEN, chatId: value.OPS_TELEGRAM_CHAT_ID },
        port: value.PORT,
        pythProAccessToken: value.PYTH_PRO_ACCESS_TOKEN,
        rpcSubscriptionsUrl: value.SOLANA_WS_URL ?? value.SOLANA_RPC_URL.replace(/^http/, 'ws'),
        rpcUrl: value.SOLANA_RPC_URL,
    };
}
