import { fetchConfig, fetchPythStorage, findConfigPda } from '@laterite/client';
import { fetchPythProUpdate, PYTH_USDT_FEED_ID } from '@laterite/client/node';
import { createDatabase } from '@laterite/db';
import type { PoolName } from '@laterite/devnet';
import { addresses as devnet } from '@laterite/devnet/addresses';
import { createSolanaRpcSubscriptions, getBase58Decoder } from '@solana/kit';
import { fetchSysvarClock } from '@solana/sysvars';
import { sql } from 'drizzle-orm';

import { Alarms, telegramNotifier } from './alarms/alarms';
import { THRESHOLDS } from './alarms/checks';
import { Monitor } from './alarms/monitor';
import { ConfigError, loadConfig } from './config';
import { Crank } from './crank/crank';
import { KaminoRelay, PythProUpdates } from './crank/prices';
import { Repegger } from './crank/repeg';
import { cpmmRoutes, JUPITER_REQUEST_INTERVAL_MS, jupiterRoutes, rateLimitedFetch } from './crank/routes';
import { startHealthServer } from './health';
import { Indexer } from './indexer/indexer';
import { acquireLeadership } from './leader';
import { createLogger, type Logger } from './log';
import { every } from './loop';
import { createFailoverRpc } from './rpc';
import { createSender } from './send';
import { Watcher } from './watcher/watcher';

/** The cluster this build serves: its addresses come from `@laterite/devnet`. */
const CLUSTER = 'devnet';
const INDEXER_INTERVAL_MS = 3_000;
const MONITOR_INTERVAL_MS = 30_000;
const WATCHER_INTERVAL_MS = 1_000;
const RECORDS_INTERVAL_MS = 60_000;
const CRANK_INTERVAL_MS = 30_000;
const REPEG_INTERVAL_MS = 30_000;
/** How long the crank may go without finishing a run. */
const CRANK_STALL_MS = 10 * 60 * 1_000;

async function main(log: Logger) {
    const config = await loadConfig();
    log.level = config.logLevel;
    const db = createDatabase(config.databaseUrl, { max: 8 });
    const rpc = createFailoverRpc([config.rpcUrl]);

    // Refuse to start against another cluster than the one whose deployment this build's addresses name.
    const [{ data: onChain }, genesisHash] = await Promise.all([
        fetchConfig(rpc, (await findConfigPda())[0]),
        rpc.getGenesisHash().send(),
    ]);
    if (getBase58Decoder().decode(onChain.genesisHash) !== genesisHash) {
        throw new Error(`the RPC's cluster ${genesisHash} is not the one Laterite's config names`);
    }

    const indexer = new Indexer(
        db,
        rpc,
        onChain.assets.map(({ mint }) => mint),
        log,
    );
    const alarms = new Alarms(
        db,
        telegramNotifier(config.ops.botToken, config.ops.chatId),
        log,
        `[laterite ${CLUSTER}]`,
    );
    const rpcSubscriptions = createSolanaRpcSubscriptions(config.rpcSubscriptionsUrl);
    const watcher = new Watcher({
        alarms,
        attestor: config.attestor,
        crank: config.crank,
        db,
        log,
        rpc,
        rpcSubscriptions,
    });
    const storage = () => fetchPythStorage(rpc);
    const relay = new KaminoRelay({
        feedIds: onChain.assets.map(({ pythFeedId }) => pythFeedId),
        log,
        mainnet: createFailoverRpc(config.mainnetRpcUrls),
        mainnetSubscriptions: createSolanaRpcSubscriptions(config.mainnetSubscriptionsUrl),
        storage,
    });
    const pythPro = new PythProUpdates({ accessToken: config.pythProAccessToken, storage });
    const sender = createSender({ payer: config.crank, rpc, rpcSubscriptions });
    // Devnet swaps through our CPMM pools, which the treasury keeps at Pyth's prices; any other router is Jupiter.
    const throughCpmm = onChain.router === devnet.cpmm.program;
    const repegger = throughCpmm
        ? new Repegger({
              addresses: devnet,
              assetUpdates: () => relay.updates(),
              log,
              pools: Object.keys(devnet.pools) as PoolName[],
              rpc,
              treasury: createSender({ payer: config.treasury, rpc, rpcSubscriptions }),
              usdtUpdate: now => pythPro.payment(PYTH_USDT_FEED_ID, now),
          })
        : undefined;
    const crank = new Crank({
        alarms,
        crank: config.crank,
        db,
        log,
        prices: {
            asset: (feedId, now) => relay.asset(feedId, now),
            payment: (feedId, now) => pythPro.payment(feedId, now),
        },
        repegger,
        routes: throughCpmm
            ? cpmmRoutes(rpc, devnet)
            : jupiterRoutes({
                  apiKey: config.jupiterApiKey,
                  db,
                  fetch: rateLimitedFetch(
                      config.jupiterApiKey ? JUPITER_REQUEST_INTERVAL_MS.keyed : JUPITER_REQUEST_INTERVAL_MS.keyless,
                  ),
                  log,
                  rpc,
                  sender,
              }),
        rpc,
        sender,
    });
    const monitor = new Monitor({
        alarms,
        cluster: CLUSTER,
        crank: config.crank.address,
        db,
        indexerLastSuccessAt: () => indexer.lastSuccessAt,
        kaminoUpdates: () => relay.updates(),
        log,
        pythUsdtUpdate: () =>
            fetchPythProUpdate({ accessToken: config.pythProAccessToken, priceFeedIds: [PYTH_USDT_FEED_ID] }),
        rpc,
        tokens: devnet.tokens,
        treasury: devnet.treasury,
    });

    const startedAt = Date.now();
    let role: 'leader' | 'standby' = 'standby';
    const server = await startHealthServer(
        config.port,
        {
            database: async () => {
                await db.execute(sql`select 1`);
                return { ok: true };
            },
            operator: async () => {
                const since = indexer.lastSuccessAt ?? startedAt;
                return {
                    alarms: (await alarms.firing()).map(({ key }) => key),
                    indexedAt: indexer.lastSuccessAt && new Date(indexer.lastSuccessAt).toISOString(),
                    ok: role === 'standby' || Date.now() - since <= THRESHOLDS.indexerStallMs,
                    role,
                };
            },
            crank: async () => {
                const since = crank.lastSuccessAt ?? startedAt;
                const now = BigInt(Math.floor(Date.now() / 1_000));
                return {
                    assetUpdateAges: Object.fromEntries(
                        [...relay.updates()].map(([feedId, { updatedAt }]) => [feedId, Number(now - updatedAt)]),
                    ),
                    lastRunAt: crank.lastSuccessAt && new Date(crank.lastSuccessAt).toISOString(),
                    ok: role === 'standby' || Date.now() - since <= CRANK_STALL_MS,
                    today: crank.day === null ? null : await crank.outcomes(crank.day),
                };
            },
            // A key that Config does not name, or an RPC on another cluster, fails the deploy's health check.
            watcher: async () => {
                const { mismatch } = await watcher.deploymentCheck();
                const since = watcher.lastSuccessAt ?? startedAt;
                return {
                    attestor: config.attestor.address,
                    mismatch,
                    ok: mismatch === null && (role === 'standby' || Date.now() - since <= THRESHOLDS.indexerStallMs),
                    records: watcher.records && {
                        lockedLamports: watcher.records.lockedLamports.toString(),
                        open: watcher.records.open,
                    },
                    watchedAccounts: watcher.watchedAccounts().length,
                };
            },
        },
        log,
    );

    const stopping = new AbortController();
    let running: Promise<unknown> | undefined;
    let release: (() => Promise<void>) | undefined;
    const shutdown = async (signal: string) => {
        if (stopping.signal.aborted) return;
        log.info({ signal, role }, 'shutting down');
        stopping.abort();
        watcher.stop();
        server.close();
        // A standby holds nothing: its pending lock request ends with the process.
        if (role === 'leader') {
            await running;
            await release?.();
            await db.$client.end();
        }
        process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));

    log.info(
        {
            attestor: config.attestor.address,
            crank: config.crank.address,
            genesisHash,
            router: onChain.router,
            treasury: config.treasury.address,
        },
        'waiting for the operator lock',
    );
    release = await acquireLeadership(db, error => {
        log.fatal({ err: error }, 'lost the operator lock');
        process.exit(1);
    });
    role = 'leader';
    log.info('operating');
    relay.start(stopping.signal);
    running = Promise.all([
        every('indexer', INDEXER_INTERVAL_MS, () => indexer.poll(), log, stopping.signal),
        every('monitor', MONITOR_INTERVAL_MS, () => monitor.tick(), log, stopping.signal),
        every('watcher', WATCHER_INTERVAL_MS, () => watcher.tick(), log, stopping.signal),
        every('records', RECORDS_INTERVAL_MS, () => watcher.closeRecords(), log, stopping.signal),
        every('crank', CRANK_INTERVAL_MS, () => crank.tick(), log, stopping.signal),
        repegger &&
            every(
                'repeg',
                REPEG_INTERVAL_MS,
                async () => {
                    const { unixTimestamp } = await fetchSysvarClock(rpc, { commitment: 'confirmed' });
                    await alarms.set(await repegger.tick(unixTimestamp));
                },
                log,
                stopping.signal,
            ),
    ]);
}

const log = createLogger(process.env.LOG_LEVEL ?? 'info');
main(log).catch(error => {
    log.fatal(
        error instanceof ConfigError ? { variables: error.variables } : { err: error },
        error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
});
