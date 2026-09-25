import { createHash } from 'node:crypto';

import { telegramLinkRequests, telegramLinks } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import { generateKeyPairSigner, getBase58Decoder, type KeyPairSigner } from '@solana/kit';
import { eq } from 'drizzle-orm';
import { createTranslator } from 'next-intl';
import en from '@laterite/i18n/messages/en.json';
import es from '@laterite/i18n/messages/es-AR.json';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LINK_TOKEN_TTL_MS, telegramLinkMessage, type TelegramLinkTranslator } from '@/lib/telegram';

const translators = {
    en: createTranslator({ locale: 'en', messages: en, namespace: 'bot.link' }) as TelegramLinkTranslator,
    'es-AR': createTranslator({ locale: 'es-AR', messages: es, namespace: 'bot.link' }) as TelegramLinkTranslator,
};

/** A wallet's signed link or unlink request, as the linking page asks for it. */
async function signed(
    action: 'link' | 'unlink',
    options: { issuedAt?: string; locale?: keyof typeof translators; signer?: KeyPairSigner } = {},
) {
    const { issuedAt = new Date().toISOString(), locale = 'en' } = options;
    const signer = options.signer ?? (await generateKeyPairSigner());
    const text = telegramLinkMessage(translators[locale], action, {
        domain: 'app.laterite.cash',
        issuedAt,
        wallet: signer.address,
    });
    const [signatures] = await signer.signMessages([{ content: new TextEncoder().encode(text), signatures: {} }]);
    const signature = getBase58Decoder().decode(signatures[signer.address]);
    return { body: { issuedAt, locale, signature, wallet: signer.address }, signer, text };
}

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let route: typeof import('@/app/api/telegram/route');

beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    process.env.TELEGRAM_BOT_USERNAME = 'laterite_bot';
    route = await import('@/app/api/telegram/route');
});
afterAll(async () => {
    await (await import('@/lib/db')).database().$client.end();
    await db.drop();
});

const call = (method: 'DELETE' | 'POST', body: unknown) =>
    route[method](
        new NextRequest('https://app.laterite.cash/api/telegram', {
            body: typeof body === 'string' ? body : JSON.stringify(body),
            method,
        }),
    );
const linked = async (wallet: string) =>
    (await route.GET(new NextRequest(`https://app.laterite.cash/api/telegram?wallet=${wallet}`))).json();

describe('telegramLinkMessage', () => {
    it('is the text the wallet reads, for a link and an unlink', () => {
        const request = {
            domain: 'app.laterite.cash',
            issuedAt: '2026-09-25T12:00:00.000Z',
            wallet: 'LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf',
        };
        expect(telegramLinkMessage(translators.en, 'link', request)).toBe(
            [
                'Laterite notifications on Telegram',
                'app.laterite.cash asks you to link a Telegram chat to this wallet. The chat will get your purchases, goal milestones and skipped days.',
                'Wallet: LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf',
                'Issued at: 2026-09-25T12:00:00.000Z',
            ].join('\n'),
        );
        expect(telegramLinkMessage(translators['es-AR'], 'unlink', request)).toBe(
            [
                'Notificaciones de Laterite en Telegram',
                'app.laterite.cash te pide que desvincules todos los chats de Telegram de esta billetera.',
                'Billetera: LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf',
                'Emitida el: 2026-09-25T12:00:00.000Z',
            ].join('\n'),
        );
    });
});

describe('/api/telegram', () => {
    it("turns a wallet's signed link request into a one-time bot link, kept only as its hash", async () => {
        const { body, signer, text } = await signed('link', { locale: 'es-AR' });
        const before = Date.now();
        const response = await call('POST', body);
        expect(response.status).toBe(201);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const { expiresAt, link } = await response.json();
        const token = new URL(link).searchParams.get('start')!;
        expect(link).toBe(`https://t.me/laterite_bot?start=${token}`);
        // Telegram's start parameter: at most 64 characters of A–Z, a–z, 0–9, _ and -
        expect(token).toMatch(/^[\w-]{43}$/);
        expect(Date.parse(expiresAt) - before).toBeGreaterThanOrEqual(LINK_TOKEN_TTL_MS);

        const [row] = await db.db
            .select()
            .from(telegramLinkRequests)
            .where(eq(telegramLinkRequests.wallet, signer.address));
        expect(row).toMatchObject({
            locale: 'es-AR',
            message: text,
            signature: body.signature,
            tokenHash: createHash('sha256').update(token).digest('hex'),
            usedAt: null,
        });
        expect(row!.expiresAt.toISOString()).toBe(expiresAt);
        // A signature makes one request.
        expect((await call('POST', body)).status).toBe(409);
    });

    it('refuses a forged, foreign, stale or unlink signature and a malformed body', async () => {
        const { body } = await signed('link');
        const other = await signed('link');
        const refused = async (changes: unknown) => {
            const response = await call(
                'POST',
                typeof changes === 'string' ? changes : { ...body, ...(changes as object) },
            );
            return [response.status, (await response.json()).error];
        };
        expect(await refused({ wallet: other.body.wallet })).toEqual([400, 'signature does not match']);
        expect(await refused({ locale: 'es-AR' })).toEqual([400, 'signature does not match']);
        expect(await refused({ signature: (await signed('unlink', { signer: other.signer })).body.signature })).toEqual(
            [400, 'signature does not match'],
        );
        const stale = await signed('link', { issuedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
        expect((await call('POST', stale.body)).status).toBe(400);
        expect(await refused({ locale: 'fr' })).toEqual([400, 'locale is not supported']);
        expect(await refused({ signature: undefined })).toEqual([400, 'wallet, issuedAt and signature are required']);
        expect(await refused('{')).toEqual([400, 'the body is not JSON']);
        expect(await refused('x'.repeat(4097))).toEqual([413, 'the body is too large']);
        expect(
            await db.db.select().from(telegramLinkRequests).where(eq(telegramLinkRequests.wallet, body.wallet)),
        ).toEqual([]);
    });

    it("reports a wallet's link and revokes every chat on its signed unlink request", async () => {
        const { body, signer } = await signed('unlink');
        await db.db.insert(telegramLinks).values([
            { chatId: 1n, messageSignature: 'a', wallet: signer.address },
            { chatId: 2n, messageSignature: 'b', wallet: signer.address },
        ]);
        expect(await linked(signer.address)).toEqual({ linked: true });
        // A link request's signature cannot unlink.
        const link = await signed('link', { signer });
        expect((await call('DELETE', link.body)).status).toBe(400);
        expect(await linked(signer.address)).toEqual({ linked: true });

        const response = await call('DELETE', body);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ linked: false });
        expect(await linked(signer.address)).toEqual({ linked: false });
        const rows = await db.db.select().from(telegramLinks).where(eq(telegramLinks.wallet, signer.address));
        expect(rows.map(row => row.revokedAt)).toEqual([expect.any(Date), expect.any(Date)]);
        expect((await route.GET(new NextRequest('https://app.laterite.cash/api/telegram?wallet=x'))).status).toBe(400);
    });
});
