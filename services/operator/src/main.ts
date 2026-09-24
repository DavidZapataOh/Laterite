import { fetchConfig, findConfigPda } from '@laterite/client';
import { fetchPythProUpdate, PYTH_USDT_FEED_ID } from '@laterite/client/node';
import { createDatabase } from '@laterite/db';
import { addresses as devnet } from '@laterite/devnet/addresses';
import { getBase58Decoder } from '@solana/kit';
import { sql } from 'drizzle-orm';

import { Alarms, webhookNotifier } from './alarms/alarms';
import { THRESHOLDS } from './alarms/checks';
import { Monitor } from './alarms/monitor';
import { ConfigError, loadConfig } from './config';
import { startHealthServer } from './health';
import { Indexer } from './indexer/indexer';
import { acquireLeadership } from './leader';
import { createLogger, type Logger } from './log';
import { every } from './loop';
import { createFailoverRpc } from './rpc';

/** The cluster this build serves: its addresses come from `@laterite/devnet`. */
const CLUSTER = 'devnet';
const INDEXER_INTERVAL_MS = 3_000;
const MONITOR_INTERVAL_MS = 30_000;

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
    const alarms = new Alarms(db, webhookNotifier(config.alertWebhookUrl), log, `[laterite ${CLUSTER}]`);
    const monitor = new Monitor({
        alarms,
        cluster: CLUSTER,
        crank: config.crank.address,
        db,
        indexerLastSuccessAt: () => indexer.lastSuccessAt,
        log,
        mainnetRpc: createFailoverRpc(config.mainnetRpcUrls),
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

    log.info({ crank: config.crank.address, genesisHash }, 'waiting for the operator lock');
    release = await acquireLeadership(db, error => {
        log.fatal({ err: error }, 'lost the operator lock');
        process.exit(1);
    });
    role = 'leader';
    log.info('operating');
    running = Promise.all([
        every('indexer', INDEXER_INTERVAL_MS, () => indexer.poll(), log, stopping.signal),
        every('monitor', MONITOR_INTERVAL_MS, () => monitor.tick(), log, stopping.signal),
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
