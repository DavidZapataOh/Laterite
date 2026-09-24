import { randomBytes } from 'node:crypto';

import { Client } from 'pg';

import { createDatabase, type Database, migrate } from './index';

/** A migrated database of its own for one test file, dropped by `drop`, on the server `DATABASE_URL` names. */
export async function createTestDatabase(): Promise<{ db: Database; drop: () => Promise<void>; url: string }> {
    const server = process.env.DATABASE_URL;
    if (!server) throw new Error('DATABASE_URL is required: `just db-up` starts a disposable Postgres');
    const name = `laterite_test_${randomBytes(6).toString('hex')}`;
    const admin = new Client({ connectionString: server });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const url = new URL(server);
    url.pathname = `/${name}`;
    const db = createDatabase(url.toString());
    await migrate(db);
    return {
        db,
        async drop() {
            await db.$client.end();
            await admin.query(`drop database ${name}`);
            await admin.end();
        },
        url: url.toString(),
    };
}
