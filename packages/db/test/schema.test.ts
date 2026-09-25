import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Database, migrate, MIGRATIONS_FOLDER, sweeps } from '../src';
import { createTestDatabase } from '../src/testing';

const U64_MAX = 2n ** 64n - 1n;

const sweep = (index: number, user: string, received: bigint, minOut: bigint) => ({
    asset: 0,
    assetExponent: -8,
    assetPrice: 77_847_155_496n,
    blockTime: new Date(1_790_000_000_000 + index * 1_000),
    engine: 1_000_000n,
    eventIndex: 0,
    feePayer: 'crank',
    minOut,
    multiplier: 1.0006,
    paymentToken: 0,
    pending: 0n,
    received,
    signature: `signature-${index}`,
    slot: BigInt(index),
    user,
});

describe('schema', () => {
    let db: Database;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());
    });
    afterAll(() => drop());

    it('applies every migration once', async () => {
        await migrate(db);
        const { rows } = await db.$client.query('select count(*)::int as applied from drizzle.__drizzle_migrations');
        const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
        expect(rows[0].applied).toBe(journal.entries.length);
    });

    it('keeps a u64 whole and derives the headroom in basis points of min_out', async () => {
        await db.insert(sweeps).values([sweep(0, 'a', U64_MAX, U64_MAX - 1n), sweep(1, 'a', 1_010_000n, 1_000_000n)]);
        const rows = await db.select().from(sweeps).where(eq(sweeps.user, 'a')).orderBy(sweeps.slot);
        expect(rows.map(row => [row.received, row.headroomBps])).toEqual([
            [U64_MAX, 0],
            [1_010_000n, 100],
        ]);
    });

    it("reads a user's history through its index", async () => {
        const rows = Array.from({ length: 20_000 }, (_, i) =>
            sweep(i + 2, `user-${i % 1_000}`, 1_010_000n, 1_000_000n),
        );
        for (let i = 0; i < rows.length; i += 2_000) await db.insert(sweeps).values(rows.slice(i, i + 2_000));
        await db.execute(sql`analyze sweeps`);
        const history = db
            .select()
            .from(sweeps)
            .where(eq(sweeps.user, 'user-7'))
            .orderBy(desc(sweeps.blockTime))
            .limit(50);
        const { rows: plan } = await db.$client.query(
            `explain (format json) ${history.toSQL().sql}`,
            history.toSQL().params,
        );
        expect(JSON.stringify(plan)).toContain('sweeps_user_block_time');
        expect(await history).toHaveLength(20);
    });
});
