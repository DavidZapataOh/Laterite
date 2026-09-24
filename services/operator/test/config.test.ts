import { Writable } from 'node:stream';

import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config';
import { createLogger } from '../src/log';

const seed = new Uint8Array(32).fill(9);
const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
/** A keypair file as `solana-keygen` writes it: the seed, then the public key. */
const keypairFile = JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]);

const env = {
    ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T0/B0/secret-path',
    CRANK_KEYPAIR: keypairFile,
    DATABASE_URL: 'postgresql://postgres:password@postgres.railway.internal:5432/railway',
    MAINNET_FALLBACK_RPC_URL: 'https://api.mainnet-beta.solana.com',
    MAINNET_RPC_URL: 'https://mainnet.example-rpc.com/?api-key=secret-key',
    PYTH_PRO_ACCESS_TOKEN: 'secret-token',
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
};

describe('configuration', () => {
    it("reads the host's variables, the crank's key from its keypair file", async () => {
        const config = await loadConfig(env);
        expect(config.crank.address).toBe(signer.address);
        expect(config).toMatchObject({
            logLevel: 'info',
            mainnetRpcUrls: [env.MAINNET_RPC_URL, env.MAINNET_FALLBACK_RPC_URL],
            port: 8080,
        });
        expect((await loadConfig({ ...env, LOG_LEVEL: 'debug', PORT: '3000' })).port).toBe(3000);
    });

    it('names every missing or malformed variable at once and never its value', async () => {
        const broken = {
            ...env,
            CRANK_KEYPAIR: '[1,2,3]',
            DATABASE_URL: 'https://not-postgres',
            PYTH_PRO_ACCESS_TOKEN: '',
        };
        delete (broken as Partial<typeof env>).SOLANA_RPC_URL;
        const error = await loadConfig(broken).catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).variables).toEqual([
            'CRANK_KEYPAIR',
            'DATABASE_URL',
            'PYTH_PRO_ACCESS_TOKEN',
            'SOLANA_RPC_URL',
        ]);
        expect((error as Error).message).not.toMatch(/\[1,2,3\]|not-postgres/);
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
        log.info({ accessToken: 'secret-token', slot: '12' }, 'indexed');
        log.debug('hidden');
        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0]!);
        expect(entry).toMatchObject({ accessToken: '[secret]', level: 'info', message: 'indexed', slot: '12' });
        expect(Date.parse(entry.time)).not.toBeNaN();
        expect(lines[0]).not.toContain('secret-token');
    });
});
