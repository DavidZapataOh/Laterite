import { fileURLToPath } from 'node:url';

import { createDatabase, migrate } from '@laterite/db';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = createDatabase(url);
try {
    // The image keeps the migrations next to this bundle.
    await migrate(db, fileURLToPath(new URL('migrations', import.meta.url)));
    console.log(JSON.stringify({ level: 'info', message: 'migrations applied' }));
} finally {
    await db.$client.end();
}
