import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';
import * as z from 'zod/mini';

const url = z.url({ protocol: /^https?$/ });

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
    ALERT_WEBHOOK_URL: url,
    CRANK_KEYPAIR: keypair,
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    LOG_LEVEL: z._default(z.enum(['debug', 'info', 'warn', 'error']), 'info'),
    MAINNET_FALLBACK_RPC_URL: url,
    MAINNET_RPC_URL: url,
    PORT: z._default(z.coerce.number().check(z.int(), z.positive()), 8080),
    PYTH_PRO_ACCESS_TOKEN: z.string().check(z.minLength(1)),
    SOLANA_RPC_URL: url,
});

/** The service's configuration, from the host's environment: Railway's variables and sealed secrets. */
export type Config = {
    alertWebhookUrl: string;
    crank: KeyPairSigner;
    databaseUrl: string;
    logLevel: 'debug' | 'error' | 'info' | 'warn';
    mainnetRpcUrls: [string, string];
    port: number;
    pythProAccessToken: string;
    rpcUrl: string;
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
    return {
        alertWebhookUrl: value.ALERT_WEBHOOK_URL,
        crank: await createKeyPairSignerFromBytes(value.CRANK_KEYPAIR),
        databaseUrl: value.DATABASE_URL,
        logLevel: value.LOG_LEVEL,
        mainnetRpcUrls: [value.MAINNET_RPC_URL, value.MAINNET_FALLBACK_RPC_URL],
        port: value.PORT,
        pythProAccessToken: value.PYTH_PRO_ACCESS_TOKEN,
        rpcUrl: value.SOLANA_RPC_URL,
    };
}
