import 'server-only';

import { attachDatabasePool } from '@vercel/functions';
import { createDatabase, type Database } from '@laterite/db/database';

let db: Database | undefined;

/** The app's pooled connection to Laterite's Postgres (`DATABASE_URL`), created on first use. */
export function database(): Database {
    if (!db) {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL is not set');
        db = createDatabase(url, { max: 5 });
        // lets a Vercel function release idle connections before it is suspended
        attachDatabasePool(db.$client);
    }
    return db;
}
