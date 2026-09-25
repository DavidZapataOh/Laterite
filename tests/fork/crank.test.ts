import { fetchPythStorage, fetchUserConfig, findSwapAuthorityPda, findUserConfigPda } from '@laterite/client';
import { type Database, swapAccountCreations, sweepAttempts } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import { Alarms } from '@laterite/operator/alarms';
import {
    Crank,
    JUPITER_REQUEST_INTERVAL_MS,
    jupiterRoutes,
    KaminoRelay,
    PythProUpdates,
    rateLimitedFetch,
} from '@laterite/operator/crank';
import { createLogger } from '@laterite/operator/log';
import { createFailoverRpc } from '@laterite/operator/rpc';
import { createSender } from '@laterite/operator/send';
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { forkContext } from './src/deployment';
import { airdrop, alignClock, cheatcodes, forkEstimate, rpc, rpcSubscriptions } from './src/fork';
import { jupiter } from './src/jupiter';
import { report } from './src/report';
import { refetchVenueAccounts } from './src/sweep';
import { enroll, enrollParams, fetchForkConfig } from './src/users';

/** Runs of the crank a sweep may take on the fork: each excludes the venues whose fork state failed the last. */
const RUNS = 4;

describe("the crank's own code on the mainnet fork", () => {
    let db: Database;
    let drop: () => Promise<void>;
    let crank: Crank;
    let crankKey: KeyPairSigner;
    let requests: () => number;
    const lines: string[] = [];

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());
        crankKey = await generateKeyPairSigner();
        await airdrop(crankKey.address, 10n);
        const log = createLogger('info', { write: (line: string) => void lines.push(line) });
        const storage = () => fetchPythStorage(rpc);
        const relay = new KaminoRelay({
            feedIds: [1843, 1837],
            log,
            mainnet: createFailoverRpc([
                process.env.SURFPOOL_DATASOURCE_RPC_URL || 'https://api.mainnet-beta.solana.com',
            ]),
            storage,
        });
        const accessToken = process.env.PYTH_PRO_ACCESS_TOKEN;
        if (!accessToken) throw new Error('PYTH_PRO_ACCESS_TOKEN is required for the USDT sweep');
        const pythPro = new PythProUpdates({ accessToken, storage });
        const sender = createSender({ estimate: forkEstimate, payer: crankKey, rpc, rpcSubscriptions });
        const fetch = rateLimitedFetch(
            jupiter.apiKey ? JUPITER_REQUEST_INTERVAL_MS.keyed : JUPITER_REQUEST_INTERVAL_MS.keyless,
        );
        requests = fetch.requests;
        const routes = jupiterRoutes({ apiKey: jupiter.apiKey, db, fetch, log, rpc, sender });
        crank = new Crank({
            alarms: new Alarms(db, async () => {}, log, '[laterite fork]'),
            crank: crankKey,
            db,
            log,
            prices: {
                asset: (feedId, now) => relay.asset(feedId, now),
                payment: (feedId, now) => pythPro.payment(feedId, now),
            },
            retryAfterMs: { alert: 0, nothing: 0, price: 0, slippage: 0, unknown: 0 },
            // The fork reads each venue the route writes from mainnet again, where Jupiter quoted it.
            routes: async request => {
                const route = await routes(request);
                await refetchVenueAccounts(route.instruction, request.userAssetAccount);
                return route;
            },
            rpc,
            sender,
        });
    });
    afterAll(async () => {
        await drop?.();
    });

    const attempts = (user: KeyPairSigner) =>
        db.select().from(sweepAttempts).where(eq(sweepAttempts.user, user.address)).orderBy(asc(sweepAttempts.id));

    for (const [name, paymentToken, asset, removeSwapAssetAccount] of [
        ['USDC into SPYx', 0, 0, false],
        ['USDT into SPYx', 1, 0, false],
        ['USDC into QQQx', 0, 1, true],
    ] as const) {
        it(`sweeps ${name} through Jupiter with any venue, as the crank runs`, async () => {
            const fork = await forkContext();
            const { user } = await enroll(fork, enrollParams({ asset, paymentTokens: 1 << paymentToken }));
            const config = await fetchForkConfig();
            const { mint, tokenProgram } = config.assets[asset]!;
            const [swapAuthority] = await findSwapAuthorityPda();
            const [swapAssetAccount] = await findAssociatedTokenPda({ mint, owner: swapAuthority, tokenProgram });
            if (removeSwapAssetAccount) await cheatcodes.resetAccount(swapAssetAccount).send();
            const [userConfigAddress] = await findUserConfigPda({ user: user.address });
            const before = requests();
            const started = Date.now();
            for (let run = 1; run <= RUNS; run++) {
                await alignClock();
                const { data } = await fetchUserConfig(rpc, userConfigAddress);
                await crank.sweep({ paymentToken, user: data }, config, new Set(), run - 1);
                if ((await attempts(user)).some(({ outcome }) => outcome === 'landed')) break;
            }
            const rows = await attempts(user);
            const landed = rows.find(({ outcome }) => outcome === 'landed');
            expect(landed, rows.map(({ reason }) => reason).join('; ')).toBeDefined();
            expect(landed!.quoted).toBeGreaterThanOrEqual(landed!.minOut!);
            expect(landed!.computeUnitLimit).toBeLessThanOrEqual(490_000);
            if (removeSwapAssetAccount) {
                const created = await db.select().from(swapAccountCreations);
                expect(created.map(({ address }) => address)).toContain(swapAssetAccount);
            }
            report('crank', [
                {
                    sweep: name,
                    signature: landed!.signature,
                    attempts: rows.length,
                    failures: rows
                        .filter(({ outcome }) => outcome !== 'landed')
                        .map(({ reason }) => reason)
                        .join('; '),
                    route: landed!.route,
                    bytes: landed!.bytes,
                    units: landed!.computeUnits,
                    limit: landed!.computeUnitLimit,
                    quoted: landed!.quoted,
                    minOut: landed!.minOut,
                    priceAgeSeconds: landed!.priceAgeSeconds,
                    jupiterRequests: requests() - before,
                    seconds: Math.round((Date.now() - started) / 1_000),
                },
            ]);
        });
    }
});
