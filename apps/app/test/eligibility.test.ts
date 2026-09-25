import { eligibilityDeclarations } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signedDeclaration } from './support';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let route: typeof import('@/app/api/eligibility/route');

beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    route = await import('@/app/api/eligibility/route');
});
afterAll(async () => {
    // the route's own pool, then the database
    await (await import('@/lib/db')).database().$client.end();
    await db.drop();
});

const post = (body: unknown, country = 'AR') =>
    route.POST(
        new NextRequest('https://app.laterite.cash/api/eligibility', {
            body: typeof body === 'string' ? body : JSON.stringify(body),
            headers: { 'x-vercel-ip-country': country },
            method: 'POST',
        }),
    );
const declared = async (wallet: string) =>
    (await route.GET(new NextRequest(`https://app.laterite.cash/api/eligibility?wallet=${wallet}`))).json();

describe('/api/eligibility', () => {
    it('records a signed declaration once, with its country, text and signature', async () => {
        const declaration = await signedDeclaration({ locale: 'es-AR' });
        const { signer, ...body } = declaration;
        expect(await declared(signer.address)).toEqual({ declared: false, version: '1' });

        const response = await post(body);
        expect(response.status).toBe(201);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect((await post(body)).status).toBe(201);

        const rows = await db.db.select().from(eligibilityDeclarations);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            country: 'AR',
            declarationVersion: '1',
            signature: body.signature,
            wallet: signer.address,
        });
        expect(rows[0].message).toContain('No soy una persona estadounidense');
        expect(rows[0].message).toContain(`Billetera: ${signer.address}`);
        expect(await declared(signer.address)).toEqual({ declared: true, version: '1' });
    });

    it('records no country off Vercel', async () => {
        const { signer, ...body } = await signedDeclaration();
        const response = await route.POST(
            new NextRequest('https://app.laterite.cash/api/eligibility', {
                body: JSON.stringify(body),
                method: 'POST',
            }),
        );
        expect(response.status).toBe(201);
        const rows = await db.db.select().from(eligibilityDeclarations);
        expect(rows.find(row => row.wallet === signer.address)?.country).toBeNull();
    });

    it('refuses a blocked country, a forged or foreign signature and a malformed body', async () => {
        const { signer, ...body } = await signedDeclaration();
        expect((await post(body, 'US')).status).toBe(451);
        const other = await signedDeclaration();
        const refused = async (changes: unknown) => {
            const response = await post(typeof changes === 'string' ? changes : { ...body, ...(changes as object) });
            return [response.status, (await response.json()).error];
        };
        expect(await refused({ wallet: other.wallet })).toEqual([400, 'signature does not match']);
        expect(await refused({ domain: 'app.laterite.cash', locale: 'es-AR' })).toEqual([
            400,
            'signature does not match',
        ]);
        expect(await refused({ locale: 'fr' })).toEqual([400, 'locale is not supported']);
        expect(await refused({ signature: undefined })).toEqual([400, 'wallet, issuedAt and signature are required']);
        expect(await refused('{')).toEqual([400, 'the body is not JSON']);
        expect(await refused('x'.repeat(4097))).toEqual([413, 'the body is too large']);
        expect(await declared(signer.address)).toEqual({ declared: false, version: '1' });
        expect((await route.GET(new NextRequest('https://app.laterite.cash/api/eligibility?wallet=x'))).status).toBe(
            400,
        );
    });
});
