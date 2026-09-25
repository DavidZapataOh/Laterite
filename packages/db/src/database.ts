import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema';

export * from './schema';

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

/** A pooled database on `connectionString` (Railway's `DATABASE_URL`). */
export function createDatabase(connectionString: string, config: Omit<PoolConfig, 'connectionString'> = {}): Database {
    return drizzle({ client: new Pool({ connectionString, ...config }), schema });
}
