import { fileURLToPath } from 'node:url';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema';

export * from './schema';

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

/** The committed migrations, generated from `schema.ts` by `drizzle-kit generate`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Serializes migration runs on one database: a deploy's and a developer's never interleave. */
const MIGRATION_LOCK = 7_470_010;

/** A pooled database on `connectionString` (Railway's `DATABASE_URL`). */
export function createDatabase(connectionString: string, config: Omit<PoolConfig, 'connectionString'> = {}): Database {
    return drizzle({ client: new Pool({ connectionString, ...config }), schema });
}

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
