import { LATERITE_PROGRAM_ADDRESS, scaledUiAmountMultiplier } from '@laterite/client';
import { attestations, type Database, indexerState, sweeps, userEvents } from '@laterite/db';
import type {
    Address,
    GetAccountInfoApi,
    GetMultipleAccountsApi,
    GetSignaturesForAddressApi,
    GetTransactionApi,
    Rpc,
    Signature,
} from '@solana/kit';
import { fetchAllMint } from '@solana-program/token-2022';
import { and, eq, isNull } from 'drizzle-orm';

import type { Logger } from '../log';
import { decodeTransaction, type Decoded, type FetchedTransaction } from './decode';

export type IndexerRpc = Rpc<
    GetAccountInfoApi & GetMultipleAccountsApi & GetSignaturesForAddressApi & GetTransactionApi
>;

/** Transactions fetched and stored together, in one database transaction with the cursor. */
const BATCH = 100;
/** `getTransaction` requests in flight at once. */
const CONCURRENCY = 4;
/** Rows per insert, under Postgres's 65,535 bind parameters. */
const ROWS_PER_INSERT = 1_000;

/**
 * Stores Laterite's history in Postgres from finalized transactions, oldest first, whoever sent them: sweeps with the
 * multiplier in force at their block time, attestations and their records, and the users' own controls. Every poll
 * resumes after the last stored transaction, so a restart neither skips nor repeats one; rows are keyed by signature,
 * so storing a transaction twice changes nothing.
 */
export class Indexer {
    /** When the last poll finished without an error, in milliseconds. */
    lastSuccessAt: number | null = null;

    constructor(
        private readonly db: Database,
        private readonly rpc: IndexerRpc,
        /** The asset mints in `Config.assets` order, whose multiplier each sweep records. */
        private readonly assetMints: readonly Address[],
        private readonly log: Logger,
        private readonly program: Address = LATERITE_PROGRAM_ADDRESS,
    ) {}

    /** Stores every finalized transaction since the last one stored. */
    async poll(): Promise<void> {
        const [cursor] = await this.db.select().from(indexerState).where(eq(indexerState.program, this.program));
        const pending = await this.signaturesSince(cursor?.signature as Signature | undefined);
        for (let start = 0; start < pending.length; start += BATCH) {
            await this.store(pending.slice(start, start + BATCH));
        }
        this.lastSuccessAt = Date.now();
    }

    /** The program's finalized signatures after `until`, oldest first, failed transactions included. */
    private async signaturesSince(until: Signature | undefined) {
        const newestFirst: { signature: Signature; slot: bigint }[] = [];
        let before: Signature | undefined;
        for (;;) {
            const page = await this.rpc
                .getSignaturesForAddress(this.program, { before, commitment: 'finalized', limit: 1_000, until })
                .send();
            newestFirst.push(...page);
            if (page.length < 1_000) return newestFirst.reverse();
            before = page.at(-1)!.signature;
        }
    }

    private async store(batch: { signature: Signature; slot: bigint }[]) {
        const fetched: (FetchedTransaction | null)[] = new Array(batch.length);
        for (let start = 0; start < batch.length; start += CONCURRENCY) {
            await Promise.all(
                batch.slice(start, start + CONCURRENCY).map(async ({ signature }, offset) => {
                    fetched[start + offset] = (await this.rpc
                        .getTransaction(signature, {
                            commitment: 'finalized',
                            encoding: 'base64',
                            maxSupportedTransactionVersion: 1,
                        })
                        .send()) as FetchedTransaction | null;
                }),
            );
        }
        const decoded: Decoded = { attestations: [], closes: [], sweeps: [], userEvents: [] };
        batch.forEach(({ signature }, index) => {
            const transaction = fetched[index];
            if (!transaction) throw new Error(`Finalized transaction ${signature} is not available yet`);
            const rows = decodeTransaction(signature, transaction);
            decoded.attestations.push(...rows.attestations);
            decoded.closes.push(...rows.closes);
            decoded.sweeps.push(...rows.sweeps);
            decoded.userEvents.push(...rows.userEvents);
        });
        const sweepRows = await this.withMultipliers(decoded.sweeps);
        const last = batch.at(-1)!;
        await this.db.transaction(async tx => {
            for (const [table, rows] of [
                [sweeps, sweepRows],
                [attestations, decoded.attestations],
                [userEvents, decoded.userEvents],
            ] as const) {
                for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
                    await tx
                        .insert(table)
                        .values(rows.slice(start, start + ROWS_PER_INSERT) as never)
                        .onConflictDoNothing();
                }
            }
            for (const { closedAt, closedSignature, record } of decoded.closes) {
                await tx
                    .update(attestations)
                    .set({ closedAt, closedSignature })
                    .where(and(eq(attestations.record, record), isNull(attestations.closedSignature)));
            }
            await tx
                .insert(indexerState)
                .values({ program: this.program, signature: last.signature, slot: last.slot })
                .onConflictDoUpdate({
                    set: { signature: last.signature, slot: last.slot, updatedAt: new Date() },
                    target: indexerState.program,
                });
        });
        this.log.info(
            {
                attestations: decoded.attestations.length,
                closes: decoded.closes.length,
                slot: last.slot.toString(),
                sweeps: sweepRows.length,
                transactions: batch.length,
                userEvents: decoded.userEvents.length,
            },
            'indexed',
        );
    }

    /**
     * Each sweep with its asset's ScaledUiAmount multiplier at its block time, which the program does not read: the
     * mint's `newMultiplier` once its effective time has passed, else `multiplier`.
     */
    private async withMultipliers(rows: Decoded['sweeps']) {
        if (rows.length === 0) return [];
        const mints = await fetchAllMint(this.rpc, [...this.assetMints]);
        return rows.map(row => ({
            ...row,
            multiplier: scaledUiAmountMultiplier(mints[row.asset]!.data, BigInt(row.blockTime.getTime() / 1_000)),
        }));
    }
}
