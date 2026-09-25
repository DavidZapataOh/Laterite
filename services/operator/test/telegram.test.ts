import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import {
    Engine,
    findUserConfigPda,
    getUserConfigEncoder,
    LATERITE_PROGRAM_ADDRESS,
    type UserConfigArgs,
    UserStatus,
} from '@laterite/client';
import {
    type Database,
    sweepAttempts,
    sweeps,
    telegramLinkRequests,
    telegramLinks,
    telegramNotifications,
    type UserEventData,
    userEvents,
} from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import { type Address, generateKeyPairSigner } from '@solana/kit';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../src/log';
import { createBotApi } from '../src/telegram/api';
import { linkTokenHash, TelegramBot } from '../src/telegram/bot';
import { Notices } from '../src/telegram/notices';
import { SvmChain } from './chain/svm';

const DOLLAR = 1_000_000n;
const HOUR = 3_600_000;
const entries: Record<string, unknown>[] = [];
const log = createLogger(
    'info',
    new Writable({
        write(chunk, _, done) {
            entries.push(JSON.parse(chunk.toString()));
            done();
        },
    }),
);

type Call = { body: Record<string, unknown>; method: string };
type Refusal = { description: string; error_code: number; parameters?: { retry_after: number } };

/**
 * The Telegram Bot API as the bot sees it, on a local port: it records every call, hands `getUpdates` the queued
 * updates once, and answers `sendMessage` with the next queued refusal, else success.
 */
class BotApiStandIn {
    readonly calls: Call[] = [];
    readonly updates: unknown[] = [];
    readonly refusals: Refusal[] = [];
    private server!: Server;
    url = '';

    async start() {
        this.server = createServer((request, response) => {
            let body = '';
            request.on('data', chunk => (body += chunk));
            request.on('end', () => {
                const method = request.url!.split('/').at(-1)!;
                const call = { body: JSON.parse(body), method };
                this.calls.push(call);
                const answer = (status: number, json: unknown) =>
                    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
                if (request.url !== `/bot1:product/${method}`) return answer(401, { error_code: 401, ok: false });
                if (method === 'getUpdates') return answer(200, { ok: true, result: this.updates.splice(0) });
                const refusal = this.refusals.shift();
                if (refusal) return answer(refusal.error_code, { ...refusal, ok: false });
                answer(200, { ok: true, result: { message_id: this.calls.length } });
            });
        });
        await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    /** The texts sent to `chatId` since the last look, taken off the record. */
    sent(chatId: number) {
        const texts: string[] = [];
        for (let i = this.calls.length - 1; i >= 0; i--) {
            const call = this.calls[i]!;
            if (call.method !== 'sendMessage' || call.body.chat_id !== chatId) continue;
            texts.unshift(call.body.text as string);
            this.calls.splice(i, 1);
        }
        return texts;
    }

    stop() {
        this.server.close();
    }
}

const telegram = new BotApiStandIn();
let db: Database;
let drop: () => Promise<void>;
let chain: SvmChain;
let bot: TelegramBot;
let notices: () => Notices;

beforeAll(async () => {
    await telegram.start();
    const at = BigInt(Math.floor(Date.now() / 1_000));
    [chain, { db, drop }] = await Promise.all([SvmChain.start(at), createTestDatabase()]);
    const api = createBotApi('1:product', { api: telegram.url });
    bot = new TelegramBot(api, db, log);
    // A new instance each time stands for a restart: nothing is kept in memory between ticks.
    notices = () => new Notices(api, db, chain.rpc, log);
});
afterAll(async () => {
    telegram.stop();
    await drop?.();
});
beforeEach(() => {
    telegram.calls.length = 0;
});

const now = () => BigInt(Math.floor(Date.now() / 1_000));
const message = (chatId: number, text: string, extra: object = {}) => ({
    message: { chat: { id: chatId, type: 'private' }, from: { language_code: 'en' }, text, ...extra },
    update_id: 0,
});
let nextUpdate = 100;
async function receive(...updates: ReturnType<typeof message>[]) {
    telegram.updates.push(...updates.map(update => ({ ...update, update_id: nextUpdate++ })));
    await bot.poll();
}

const accounts = new Map<Address, UserConfigArgs>();

/** Writes `wallet`'s `UserConfig` on the chain with `overrides`. */
async function write(wallet: Address, overrides: Partial<UserConfigArgs>) {
    const [pda, bump] = await findUserConfigPda({ user: wallet });
    const enrolledAt = now() - 8n * 86_400n;
    const account: UserConfigArgs = {
        asset: 0,
        attestableFrom: enrolledAt,
        bump,
        changeMultiplier: 0,
        cushions: [20n * DOLLAR, 20n * DOLLAR],
        engine: Engine.Daily,
        engineAmount: DOLLAR,
        engineRanAt: now(),
        enrolledAt,
        goalAmount: 100n * DOLLAR,
        goalLabel: new TextEncoder().encode('Bike'.padEnd(32, '\0')),
        incomeRule: true,
        lastSweepDay: [0, 0],
        paymentTokens: 0b11,
        pending: 0n,
        status: UserStatus.Active,
        tier: 0,
        user: wallet,
        week: 1,
        weekSpent: DOLLAR,
        ...accounts.get(wallet),
        ...overrides,
    };
    accounts.set(wallet, account);
    chain.write(pda, new Uint8Array(getUserConfigEncoder().encode(account)), LATERITE_PROGRAM_ADDRESS);
}

/** A new wallet enrolled a week and a day ago on the $10 tier, its `UserConfig` holding `overrides`. */
async function user(overrides: Partial<UserConfigArgs> = {}): Promise<Address> {
    const wallet = (await generateKeyPairSigner()).address;
    await write(wallet, overrides);
    return wallet;
}

async function link(wallet: Address, chatId: number, locale = 'en') {
    await db.insert(telegramLinks).values({
        chatId: BigInt(chatId),
        linkedAt: new Date(Date.now() - HOUR),
        locale,
        messageSignature: `signature-${chatId}`,
        wallet,
    });
}

let slot = 1_000n;
async function sweep(wallet: Address, amounts: { engine?: bigint; pending?: bigint }, minutesAgo = 5) {
    const signature = `sweep-${slot}`;
    await db.insert(sweeps).values({
        asset: 0,
        assetExponent: -8,
        assetPrice: 69_000_000n,
        blockTime: new Date(Date.now() - minutesAgo * 60_000),
        engine: amounts.engine ?? 0n,
        eventIndex: 0,
        feePayer: 'crank',
        minOut: 1_430_000n,
        multiplier: 1.0006,
        paymentToken: 0,
        pending: amounts.pending ?? 0n,
        received: 1_449_275n,
        signature,
        slot: slot++,
        user: wallet,
    });
    return signature;
}

async function event(wallet: Address, kind: typeof userEvents.$inferInsert.kind, data: UserEventData = {}) {
    await db.insert(userEvents).values({
        blockTime: new Date(),
        data,
        eventIndex: 0,
        kind,
        signature: `event-${slot}`,
        slot: slot++,
        user: wallet,
    });
}

const today = () => Math.floor(Date.now() / 86_400_000);
async function attempt(wallet: Address, day: number, outcome: 'landed' | 'pull_failed' | 'skipped', reason: string) {
    await db.insert(sweepAttempts).values({ at: new Date(), day, outcome, paymentToken: 0, reason, user: wallet });
}

describe('linking', () => {
    it("links the chat that starts the bot with a signed request's one-time token, in the request's locale", async () => {
        const wallet = (await generateKeyPairSigner()).address;
        const request = (token: string, expiresInMs: number) => ({
            expiresAt: new Date(Date.now() + expiresInMs),
            locale: 'es-AR',
            message: 'the signed text',
            signature: `signed-${token}`,
            tokenHash: linkTokenHash(token),
            wallet,
        });
        await db.insert(telegramLinkRequests).values([request('fresh-token', 60_000), request('old-token', -1)]);

        await receive(message(7, '/start fresh-token'));
        expect(telegram.sent(7)).toEqual([
            `Este chat ahora recibe las notificaciones de Laterite de ${wallet}. Mandá /unlink para dejar de recibirlas.`,
        ]);
        const [linked] = await db.select().from(telegramLinks).where(eq(telegramLinks.chatId, 7n));
        expect(linked).toMatchObject({
            locale: 'es-AR',
            messageSignature: 'signed-fresh-token',
            revokedAt: null,
            wallet,
        });

        // A token links once, before it expires; an unknown one never.
        await receive(message(8, '/start fresh-token'), message(8, '/start old-token'), message(8, '/start nothing'));
        expect(telegram.sent(8)).toEqual(
            Array(3).fill("This link has expired or was already used. Link Telegram again from Laterite's settings."),
        );
        expect(await db.select().from(telegramLinks).where(eq(telegramLinks.chatId, 8n))).toEqual([]);
    });

    it('revokes every link of the chat on /unlink, explains itself otherwise, and ignores groups', async () => {
        const wallets = [await user(), await user()];
        for (const wallet of wallets) await link(wallet, 9, 'es-AR');
        await receive(
            message(9, '/unlink'),
            message(9, '/unlink'),
            message(9, 'hola', { from: { language_code: 'es' } }),
            message(-100, '/start token', { chat: { id: -100, type: 'group' } }),
        );
        expect(telegram.sent(9)).toEqual([
            'Este chat ya no recibe las notificaciones de Laterite.',
            'This chat is not linked to a wallet.',
            'Vinculá este chat desde la configuración de Laterite para recibir acá tus compras, los hitos de tu meta y los días sin compra.',
        ]);
        expect(telegram.sent(-100)).toEqual([]);
        const rows = await db.select().from(telegramLinks).where(eq(telegramLinks.chatId, 9n));
        expect(rows.map(row => row.revokedAt)).toEqual([expect.any(Date), expect.any(Date)]);

        // Telegram confirms what was read with the next call's offset.
        await bot.poll();
        const offsets = telegram.calls.filter(call => call.method === 'getUpdates').map(call => call.body.offset);
        expect(offsets.at(-1)).toBe(nextUpdate);
    });
});

describe('notifications', () => {
    it('sends each purchase once, with the part from payments, what waits and the capped week', async () => {
        const plain = await user();
        const capped = await user({ pending: 6n * DOLLAR, weekSpent: 10n * DOLLAR });
        const waiting = await user({ pending: 2n * DOLLAR, weekSpent: 5n * DOLLAR });
        await link(plain, 11);
        await link(capped, 12);
        await link(waiting, 13, 'es-AR');
        const signature = await sweep(plain, { engine: DOLLAR }, 30);
        await sweep(capped, { engine: DOLLAR, pending: 8n * DOLLAR });
        await sweep(waiting, { engine: DOLLAR, pending: 2n * DOLLAR });
        // Before the chat was linked: never sent.
        await sweep(plain, { engine: DOLLAR }, 120);

        await notices().tick();
        expect(telegram.sent(11)).toEqual(['Invested $1.00 of USDC: 0.01450145 SPYx.']);
        // Each send is logged with how long after its source it left.
        const sent = entries.find(entry => entry.key === `sweep:${signature}:0`);
        expect(sent).toMatchObject({ message: 'telegram notification sent' });
        expect(sent!.latencyMs).toBeGreaterThanOrEqual(30 * 60_000);
        expect(telegram.sent(12)).toEqual([
            "Invested $9.00 of USDC: 0.01450145 SPYx. $1.00 on schedule and $8.00 from your payments. This week's $10.00 cap is reached: $6.00 waits for next week.",
        ]);
        expect(telegram.sent(13)).toEqual([
            // es-AR separates the currency from the amount with a no-break space
            'Invertiste US$\u00a03,00 de USDC: 0,01450145 SPYx. US$\u00a01,00 programados y US$\u00a02,00 de tus pagos. US$\u00a02,00 quedan por invertir.',
        ]);
        // A restart sends none of them again.
        await notices().tick();
        expect(telegram.calls.filter(call => call.method === 'sendMessage')).toEqual([]);
    });

    it('sends the highest goal milestone a purchase reaches, once', async () => {
        const wallet = await user();
        await link(wallet, 14);
        await sweep(wallet, { engine: 20n * DOLLAR }, 20);
        await sweep(wallet, { engine: 35n * DOLLAR }, 10);
        await sweep(wallet, { engine: DOLLAR }, 5);
        await notices().tick();
        expect(telegram.sent(14)).toEqual([
            'Invested $20.00 of USDC: 0.01450145 SPYx.',
            'Invested $35.00 of USDC: 0.01450145 SPYx.',
            'You reached 50% of your goal “Bike”: $55.00 of $100.00 invested.',
            'Invested $1.00 of USDC: 0.01450145 SPYx.',
        ]);
    });

    it("confirms the user's own controls, and nothing after an exit but the exit", async () => {
        const wallet = await user();
        await link(wallet, 15);
        await event(wallet, 'paused');
        await event(wallet, 'resumed');
        await event(wallet, 'tier_changed', { tier: 1 });
        await event(wallet, 'payment_tokens_changed', { paymentTokens: 0b11 });
        await event(wallet, 'settings_updated', { params: {} });
        await notices().tick();
        expect(telegram.sent(15)).toEqual([
            'Paused: nothing is bought until you resume. What waits to be invested is kept.',
            'Resumed: Laterite invests for you again.',
            'Your weekly cap is now $25.00.',
            'Laterite now invests with your USDC and USDT.',
        ]);

        const exited = await user({ status: UserStatus.Exited });
        await link(exited, 16);
        await sweep(exited, { engine: DOLLAR }, 1);
        await event(exited, 'tier_changed', { tier: 1 });
        await event(exited, 'exited');
        await attempt(exited, today(), 'skipped', 'StalePrice');
        await notices().tick();
        expect(telegram.sent(16)).toEqual([
            'You left Laterite: every permission ended. This chat gets nothing more unless you come back.',
        ]);
        // Held back, not waiting: a return does not bring them back.
        await write(exited, { status: UserStatus.Active });
        await notices().tick();
        expect(telegram.sent(16)).toEqual([]);
    });

    it('sends a skipped day once, none while paused, and a token ended outside Laterite once', async () => {
        const wallet = await user();
        const paused = await user({ status: UserStatus.Paused });
        await link(wallet, 17);
        await link(paused, 18);
        await attempt(wallet, today() - 3, 'landed', 'landed');
        await attempt(wallet, today() - 2, 'skipped', 'RestoreRequired delegate');
        await attempt(wallet, today() - 1, 'skipped', 'RestoreRequired delegate');
        await attempt(wallet, today(), 'pull_failed', 'Subscriptions 508');
        await attempt(paused, today(), 'skipped', 'StalePrice');
        await notices().tick();
        const date = (day: number) =>
            new Date(day * 86_400_000).toLocaleDateString('en', { day: 'numeric', month: 'long', timeZone: 'UTC' });
        expect(telegram.sent(17)).toEqual([
            `No USDC purchase on ${date(today() - 2)}: the permission for USDC was ended outside Laterite. Restore it in the app to invest again.`,
            `No USDC purchase on ${date(today())}: the payment could not be collected. Check your USDC balance and permission.`,
        ]);
        expect(telegram.sent(18)).toEqual([]);
        const other = await user();
        await link(other, 19, 'es-AR');
        await attempt(other, today(), 'skipped', 'StalePrice');
        await notices().tick();
        expect(telegram.sent(19)).toEqual([
            `Sin compra con USDC el ${new Date(today() * 86_400_000).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', timeZone: 'UTC' })}: no hubo precios ni rutas disponibles ese día.`,
        ]);
    });

    it('unlinks a chat that blocked the bot, and sends again after flood control or a failure', async () => {
        const blocked = await user();
        await link(blocked, 20);
        await sweep(blocked, { engine: DOLLAR }, 1);
        telegram.refusals.push({ description: 'Forbidden: bot was blocked by the user', error_code: 403 });
        await notices().tick();
        const [row] = await db.select().from(telegramLinks).where(eq(telegramLinks.chatId, 20n));
        expect(row!.revokedAt).toEqual(expect.any(Date));

        const wallet = await user();
        await link(wallet, 21);
        await sweep(wallet, { engine: DOLLAR }, 1);
        const flooded = notices();
        telegram.refusals.push({
            description: 'Too Many Requests: retry after 1',
            error_code: 429,
            parameters: { retry_after: 1 },
        });
        await flooded.tick();
        await flooded.tick();
        expect(telegram.sent(21)).toHaveLength(1);
        expect(await db.select().from(telegramNotifications).where(eq(telegramNotifications.chatId, 21n))).toEqual([]);
        await new Promise(resolve => setTimeout(resolve, 1_000));
        telegram.refusals.push({ description: 'Internal Server Error', error_code: 500 });
        await flooded.tick();
        await flooded.tick();
        expect(telegram.sent(21)).toEqual(Array(2).fill('Invested $1.00 of USDC: 0.01450145 SPYx.'));
        await flooded.tick();
        expect(telegram.sent(21)).toEqual([]);
    });

    it("reads only each chat's new rows: a tick with nothing new for 1,000 linked chats", async () => {
        const wallets = Array.from({ length: 1_000 }, (_, i) => `measured-${i}`);
        await db.insert(telegramLinks).values(
            wallets.map((wallet, i) => ({
                chatId: BigInt(100_000 + i),
                linkedAt: new Date(Date.now() - 30 * 86_400_000),
                messageSignature: wallet,
                wallet,
            })),
        );
        // A month of daily sweeps of both tokens, one day of them inside the window, all notified already.
        for (let day = 0; day < 30; day++) {
            await db.insert(sweeps).values(
                wallets.flatMap((wallet, i) =>
                    [0, 1].map(paymentToken => ({
                        asset: 0,
                        assetExponent: -8,
                        assetPrice: 69_000_000n,
                        blockTime: new Date(Date.now() - day * 86_400_000 - 60_000),
                        engine: DOLLAR,
                        eventIndex: paymentToken,
                        feePayer: 'crank',
                        minOut: 1n,
                        multiplier: 1,
                        paymentToken,
                        pending: 0n,
                        received: 1n,
                        signature: `measured-${day}-${i}`,
                        slot: BigInt(1_000_000 + day * 1_000 + i),
                        user: wallet,
                    })),
                ),
            );
        }
        await db.execute(sql`
            insert into telegram_notifications (chat_id, key, sent)
            select l.chat_id, 'sweep:' || s.signature || ':' || s.event_index, true
            from telegram_links l join sweeps s on s."user" = l.wallet where l.wallet like 'measured-%'`);
        await db.execute(sql`analyze`);
        const quiet = notices();
        await quiet.tick();
        const started = performance.now();
        for (let i = 0; i < 10; i++) await quiet.tick();
        const ms = (performance.now() - started) / 10;
        console.log(`a tick with nothing new for 1,000 linked chats and 60,000 sweeps: ${ms.toFixed(1)} ms`);
        expect(telegram.calls.filter(call => call.method === 'sendMessage')).toEqual([]);
        expect(ms).toBeLessThan(50);
    });
});
