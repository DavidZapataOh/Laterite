import { fileURLToPath } from 'node:url';

import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';

import type { Database } from './database';

export * from './database';

/** The committed migrations, generated from `schema.ts` by `drizzle-kit generate`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Serializes migration runs on one database: a deploy's and a developer's never interleave. */
const MIGRATION_LOCK = 7_470_010;

/** Applies the migrations `migrationsFolder` holds that the database lacks, in one transaction, under a lock. */
export async function migrate(db: Database, migrationsFolder = MIGRATIONS_FOLDER): Promise<void> {
    const client = await db.$client.connect();
    try {
        await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
        await runMigrations(db, { migrationsFolder });
    } finally {
        await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
        client.release();
    }
}
