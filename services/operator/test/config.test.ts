import { Writable } from 'node:stream';

import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config';
import { createLogger } from '../src/log';

/** A keypair file as `solana-keygen` writes it, the seed filled with `byte`: the seed, then the public key. */
async function keypairFile(byte: number) {
    const seed = new Uint8Array(32).fill(byte);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    return { file: JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]), signer };
}
const [crank, attestor, treasury] = await Promise.all([keypairFile(9), keypairFile(8), keypairFile(17)]);
const expected = { treasury: treasury.signer.address };

const env = {
    ATTESTOR_KEYPAIR: attestor.file,
    CRANK_KEYPAIR: crank.file,
    DATABASE_URL: 'postgresql://postgres:password@postgres.railway.internal:5432/railway',
    MAINNET_FALLBACK_RPC_URL: 'https://api.mainnet-beta.solana.com',
    MAINNET_RPC_URL: 'https://mainnet.example-rpc.com/?api-key=secret-key',
    OPS_TELEGRAM_BOT_TOKEN: '123456789:secret-bot-token-000000000000000000000',
    OPS_TELEGRAM_CHAT_ID: '-1001234567890',
    PYTH_PRO_ACCESS_TOKEN: 'secret-token',
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    TREASURY_KEYPAIR: treasury.file,
};

describe('configuration', () => {
    it("reads the host's variables, the crank's, the attestor's and the treasury's keys from their keypair files", async () => {
        const config = await loadConfig(env, expected);
        expect(config.crank.address).toBe(crank.signer.address);
        expect(config.attestor.address).toBe(attestor.signer.address);
        expect(config.treasury.address).toBe(treasury.signer.address);
        // The attestor signs messages and cannot sign a transaction.
        expect(Object.keys(config.attestor).sort()).toEqual(['address', 'signMessages']);
        expect(config).toMatchObject({
            logLevel: 'info',
            mainnetRpcUrls: [env.MAINNET_RPC_URL, env.MAINNET_FALLBACK_RPC_URL],
            mainnetSubscriptionsUrl: 'wss://mainnet.example-rpc.com/?api-key=secret-key',
            ops: { botToken: env.OPS_TELEGRAM_BOT_TOKEN, chatId: env.OPS_TELEGRAM_CHAT_ID },
            port: 8080,
            rpcSubscriptionsUrl: 'wss://api.devnet.solana.com',
        });
        expect(config.jupiterApiKey).toBeUndefined();
        const other = await loadConfig(
            {
                ...env,
                JUPITER_API_KEY: 'jupiter-key',
                LOG_LEVEL: 'debug',
                MAINNET_WS_URL: 'wss://mainnet-ws.example-rpc.com',
                PORT: '3000',
                SOLANA_WS_URL: 'ws://127.0.0.1:8900',
            },
            expected,
        );
        expect(other).toMatchObject({
            jupiterApiKey: 'jupiter-key',
            mainnetSubscriptionsUrl: 'wss://mainnet-ws.example-rpc.com',
            port: 3000,
            rpcSubscriptionsUrl: 'ws://127.0.0.1:8900',
        });
    });

    it('refuses the crank as attestor', async () => {
        const error = await loadConfig({ ...env, ATTESTOR_KEYPAIR: crank.file }, expected).catch(
            (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).variables).toEqual(['ATTESTOR_KEYPAIR']);
    });

    it('refuses a treasury key that is not the devnet treasury', async () => {
        const error = await loadConfig(env).catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).variables).toEqual(['TREASURY_KEYPAIR']);
    });

    it('names every missing or malformed variable at once and never its value', async () => {
        const broken = {
            ...env,
            ATTESTOR_KEYPAIR: 'not-json',
            CRANK_KEYPAIR: '[1,2,3]',
            DATABASE_URL: 'https://not-postgres',
            OPS_TELEGRAM_BOT_TOKEN: 'not-a-bot-token',
            PYTH_PRO_ACCESS_TOKEN: '',
            TREASURY_KEYPAIR: '[4,5,6]',
        };
        delete (broken as Partial<typeof env>).SOLANA_RPC_URL;
        const error = await loadConfig(broken, expected).catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).variables).toEqual([
            'ATTESTOR_KEYPAIR',
            'CRANK_KEYPAIR',
            'DATABASE_URL',
            'OPS_TELEGRAM_BOT_TOKEN',
            'PYTH_PRO_ACCESS_TOKEN',
            'SOLANA_RPC_URL',
            'TREASURY_KEYPAIR',
        ]);
        expect((error as Error).message).not.toMatch(/\[1,2,3\]|\[4,5,6\]|not-json|not-postgres|not-a-bot-token/);
    });
});

describe('logs', () => {
    it("writes one JSON line per entry in Railway's format and censors secrets", () => {
        const lines: string[] = [];
        const sink = new Writable({
            write(chunk, _, done) {
                lines.push(chunk.toString());
                done();
            },
        });
        const log = createLogger('info', sink);
        log.info(
            {
                accessToken: 'secret-token',
                jupiter: { apiKey: 'secret-key' },
                ops: { botToken: 'secret-bot' },
                slot: '12',
            },
            'indexed',
        );
        log.debug('hidden');
        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0]!);
        expect(entry).toMatchObject({
            accessToken: '[secret]',
            jupiter: { apiKey: '[secret]' },
            level: 'info',
            message: 'indexed',
            ops: { botToken: '[secret]' },
            slot: '12',
        });
        expect(Date.parse(entry.time)).not.toBeNaN();
        expect(lines[0]).not.toMatch(/secret-token|secret-key|secret-bot/);
    });
});
