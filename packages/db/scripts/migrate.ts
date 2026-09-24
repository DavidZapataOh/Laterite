import { createDatabase, migrate } from '../src';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = createDatabase(url);
try {
    await migrate(db);
    console.log('✓ Migrations applied');
} finally {
    await db.$client.end();
}
