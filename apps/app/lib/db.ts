import 'server-only';

import { attachDatabasePool } from '@vercel/functions';
import { and, eq } from 'drizzle-orm';
import { createDatabase, type Database, eligibilityDeclarations } from '@laterite/db/database';

import { DECLARATION_VERSION } from './declaration';

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

/** Whether `wallet` declared the current version of the eligibility declaration. */
export async function isDeclared(db: Database, wallet: string): Promise<boolean> {
    const [row] = await db
        .select({ wallet: eligibilityDeclarations.wallet })
        .from(eligibilityDeclarations)
        .where(
            and(
                eq(eligibilityDeclarations.wallet, wallet),
                eq(eligibilityDeclarations.declarationVersion, DECLARATION_VERSION),
            ),
        )
        .limit(1);
    return row !== undefined;
}
