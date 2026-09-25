import { type Config, fetchConfig, findConfigPda } from '@laterite/client';
import type { Database } from '@laterite/db';
import type { TokenSymbol } from '@laterite/devnet/addresses';
import type { Address, ReadonlyUint8Array, Rpc, SolanaRpcApi } from '@solana/kit';

import type { Logger } from '../log';
import type { Alarms } from './alarms';
import {
    balanceAlarms,
    calendarAlarm,
    headroomAlarm,
    indexerAlarm,
    kaminoAlarms,
    pythTokenAlarm,
    swapAccountAlarm,
} from './checks';

/** Failed runs in a row after which a check that cannot read its source fires an alarm of its own. */
const FAILURES_TO_ALARM = 3;

export type MonitorInput = {
    alarms: Alarms;
    cluster: 'devnet' | 'mainnet';
    crank: Address;
    db: Database;
    indexerLastSuccessAt: () => number | null;
    /** The Kamino Scope relay's latest update of each asset feed. */
    kaminoUpdates: () => ReadonlyMap<number, { message: ReadonlyUint8Array }>;
    log: Logger;
    /** Fetches a USDT/USD update from Pyth Pro with the service's token. */
    pythUsdtUpdate: () => Promise<unknown>;
    rpc: Rpc<SolanaRpcApi>;
    tokens: Record<TokenSymbol, { mint: Address; tokenProgram: Address }>;
    treasury: Address;
};

/** Runs every operations check and brings its alarms up to date. */
export class Monitor {
    private readonly failures = new Map<string, number>();
    private readonly startedAt = Date.now();

    constructor(private readonly input: MonitorInput) {}

    async tick(now = Date.now()): Promise<void> {
        const { alarms, cluster, crank, db, log, rpc, tokens, treasury } = this.input;
        const seconds = BigInt(Math.floor(now / 1_000));
        let config: Config | undefined;
        const readConfig = async () => (config ??= (await fetchConfig(rpc, (await findConfigPda())[0])).data);
        const checks: Record<string, () => Promise<Record<string, string | null>>> = {
            balances: async () => balanceAlarms(rpc, await readConfig(), { crank, treasury }, tokens, cluster),
            calendar: async () => ({
                'market-calendar': calendarAlarm((await readConfig()).marketCalendar, seconds, cluster),
            }),
            headroom: () => headroomAlarm(db, crank, cluster),
            indexer: async () => indexerAlarm(this.input.indexerLastSuccessAt(), this.startedAt, now),
            kamino: async () => {
                const assets = (await readConfig()).assets;
                const feeds = assets.map(({ pythFeedId }, index) => ({
                    feedId: pythFeedId,
                    name: ['SPYX', 'QQQX'][index] ?? `asset ${index}`,
                }));
                return kaminoAlarms(
                    this.input.kaminoUpdates(),
                    feeds,
                    seconds,
                    BigInt(Math.floor(this.startedAt / 1_000)),
                );
            },
            'pyth-pro': () => pythTokenAlarm(this.input.pythUsdtUpdate),
            'swap-accounts': () => swapAccountAlarm(db, new Date(now)),
        };
        for (const [name, check] of Object.entries(checks)) {
            try {
                const states = await check();
                this.failures.delete(name);
                await alarms.set({ ...states, [`check-${name}`]: null }, new Date(now));
            } catch (error) {
                const failures = (this.failures.get(name) ?? 0) + 1;
                this.failures.set(name, failures);
                log.warn({ check: name, err: error, failures }, 'check failed');
                if (failures >= FAILURES_TO_ALARM) {
                    const reason = error instanceof Error ? error.message : String(error);
                    await alarms.set(
                        { [`check-${name}`]: `the ${name} check failed ${failures} times in a row: ${reason}` },
                        new Date(now),
                    );
                }
            }
        }
    }
}
