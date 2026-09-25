import { addresses as devnet } from '@laterite/devnet/addresses';
import { type Address, createKeyPairSignerFromBytes, type KeyPairSigner, type MessagePartialSigner } from '@solana/kit';
import * as z from 'zod/mini';

const url = z.url({ protocol: /^https?$/ });
const wsUrl = z.url({ protocol: /^wss?$/ });

const botToken = z.string().check(z.regex(/^\d+:[\w-]{30,}$/));

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
    JUPITER_API_KEY: z.optional(z.string().check(z.minLength(1))),
    LOG_LEVEL: z._default(z.enum(['debug', 'info', 'warn', 'error']), 'info'),
    MAINNET_FALLBACK_RPC_URL: url,
    MAINNET_RPC_URL: url,
    MAINNET_WS_URL: z.optional(wsUrl),
    OPS_TELEGRAM_BOT_TOKEN: botToken,
    OPS_TELEGRAM_CHAT_ID: z.string().check(z.regex(/^-?\d+$/)),
    PORT: z._default(z.coerce.number().check(z.int(), z.positive()), 8080),
    PYTH_PRO_ACCESS_TOKEN: z.string().check(z.minLength(1)),
    SOLANA_RPC_URL: url,
    SOLANA_WS_URL: z.optional(wsUrl),
    TELEGRAM_BOT_TOKEN: botToken,
    TREASURY_KEYPAIR: keypair,
});

/** The service's configuration, from the host's environment: Railway's variables and sealed secrets. */
export type Config = {
    /** Signs attestation messages only: it cannot sign a transaction. */
    attestor: MessagePartialSigner;
    crank: KeyPairSigner;
    databaseUrl: string;
    /** Jupiter's API key, for a deployment that routes through Jupiter (keyless access is slower). */
    jupiterApiKey?: string;
    logLevel: 'debug' | 'error' | 'info' | 'warn';
    mainnetRpcUrls: [string, string];
    /** The primary mainnet provider's WebSocket endpoint: `MAINNET_WS_URL`, else `MAINNET_RPC_URL` on `ws`/`wss`. */
    mainnetSubscriptionsUrl: string;
    ops: { botToken: string; chatId: string };
    port: number;
    pythProAccessToken: string;
    rpcUrl: string;
    /** The RPC's WebSocket endpoint: `SOLANA_WS_URL`, else `SOLANA_RPC_URL` on `ws`/`wss`, as providers serve both. */
    rpcSubscriptionsUrl: string;
    /** The product bot, which writes to the users' linked chats: never the operations bot. */
    telegram: { botToken: string };
    /** The devnet treasury, which re-pegs the devnet pools: read only by the crank. */
    treasury: KeyPairSigner;
};

/** Thrown for a missing or malformed variable; names the variables, never their values. */
export class ConfigError extends Error {
    constructor(readonly variables: string[]) {
        super(`Missing or malformed environment variables: ${variables.join(', ')}`);
        this.name = 'ConfigError';
    }
}

/**
 * Reads and checks every variable at once, so a deploy fails at start with the full list of what is wrong. The
 * treasury key must be `expected.treasury` (the devnet treasury the pools' inventory belongs to).
 */
export async function loadConfig(
    env: NodeJS.ProcessEnv = process.env,
    expected: { treasury: Address } = { treasury: devnet.treasury },
): Promise<Config> {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
        throw new ConfigError([...new Set(parsed.error.issues.map(issue => String(issue.path[0])))].sort());
    }
    const value = parsed.data;
    const [attestor, crank, treasury] = await Promise.all([
        createKeyPairSignerFromBytes(value.ATTESTOR_KEYPAIR),
        createKeyPairSignerFromBytes(value.CRANK_KEYPAIR),
        createKeyPairSignerFromBytes(value.TREASURY_KEYPAIR),
    ]);
    // The attestor never pays or signs a transaction, so it must not be the crank.
    if (attestor.address === crank.address) throw new ConfigError(['ATTESTOR_KEYPAIR']);
    if (treasury.address !== expected.treasury) throw new ConfigError(['TREASURY_KEYPAIR']);
    // Users' chats and the operations chat never share a bot; a token starts with its bot's id.
    const botId = (token: string) => token.split(':')[0];
    if (botId(value.TELEGRAM_BOT_TOKEN) === botId(value.OPS_TELEGRAM_BOT_TOKEN)) {
        throw new ConfigError(['TELEGRAM_BOT_TOKEN']);
    }
    return {
        attestor: { address: attestor.address, signMessages: attestor.signMessages },
        crank,
        databaseUrl: value.DATABASE_URL,
        jupiterApiKey: value.JUPITER_API_KEY,
        logLevel: value.LOG_LEVEL,
        mainnetRpcUrls: [value.MAINNET_RPC_URL, value.MAINNET_FALLBACK_RPC_URL],
        mainnetSubscriptionsUrl: value.MAINNET_WS_URL ?? value.MAINNET_RPC_URL.replace(/^http/, 'ws'),
        ops: { botToken: value.OPS_TELEGRAM_BOT_TOKEN, chatId: value.OPS_TELEGRAM_CHAT_ID },
        port: value.PORT,
        pythProAccessToken: value.PYTH_PRO_ACCESS_TOKEN,
        rpcSubscriptionsUrl: value.SOLANA_WS_URL ?? value.SOLANA_RPC_URL.replace(/^http/, 'ws'),
        rpcUrl: value.SOLANA_RPC_URL,
        telegram: { botToken: value.TELEGRAM_BOT_TOKEN },
        treasury,
    };
}
