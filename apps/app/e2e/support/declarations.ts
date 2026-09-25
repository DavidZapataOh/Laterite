import { createPrivateKey, sign } from 'node:crypto';

import { getBase58Decoder } from '@solana/kit';
import { createTranslator } from 'next-intl';
import { createDatabase, eligibilityDeclarations, migrate } from '@laterite/db';
import en from '@laterite/i18n/messages/en.json' with { type: 'json' };

import { DECLARATION_VERSION, declarationMessage, type DeclarationTranslator } from '../../lib/declaration';
import type { TestKey } from './keys';
import { APP_ORIGIN } from './origin';

const t = createTranslator({ locale: 'en', messages: en, namespace: 'declaration' }) as DeclarationTranslator;

/** Migrates `DATABASE_URL` and records a real signed declaration for each of `keys`, as the app would. */
export async function declare(keys: TestKey[]) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required: `just db-up` starts a disposable Postgres');
    const db = createDatabase(url);
    try {
        await migrate(db);
        const issuedAt = new Date().toISOString();
        const rows = keys.map(({ address, jwk }) => {
            const message = declarationMessage(t, { domain: new URL(APP_ORIGIN).host, issuedAt, wallet: address });
            const signature = sign(null, Buffer.from(message), createPrivateKey({ format: 'jwk', key: jwk }));
            return {
                country: 'AR',
                declarationVersion: DECLARATION_VERSION,
                message,
                signature: getBase58Decoder().decode(signature),
                wallet: address,
            };
        });
        await db.insert(eligibilityDeclarations).values(rows).onConflictDoNothing();
    } finally {
        await db.$client.end();
    }
}
