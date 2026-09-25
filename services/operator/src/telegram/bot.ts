import { createHash } from 'node:crypto';

import { type Database, telegramLinkRequests, telegramLinks } from '@laterite/db';
import { and, eq, gt, isNull } from 'drizzle-orm';

import type { Logger } from '../log';
import type { BotApi, Message, Update } from './api';
import { botTranslator, localeOf } from './messages';

/** How long one `getUpdates` waits for a message, in seconds. */
export const LONG_POLL_SECONDS = 25;

/** The SHA-256 the database keeps of a link request's one-time token. */
export const linkTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The product bot's conversation, over long polling: `/start <token>` links the private chat to the wallet whose signed
 * request carries that one-time token, `/unlink` revokes every link of the chat, and anything else explains how to
 * link. Group chats are ignored, so a wallet's notifications never reach other people.
 */
export class TelegramBot {
    private offset = 0;

    constructor(
        private readonly api: BotApi,
        private readonly db: Database,
        private readonly log: Logger,
    ) {}

    /** Waits for the next messages and answers each; Telegram confirms them with the next call's offset. */
    async poll(signal?: AbortSignal): Promise<true> {
        const updates = await this.api<Update[]>(
            'getUpdates',
            { allowed_updates: ['message'], offset: this.offset, timeout: LONG_POLL_SECONDS },
            signal,
        );
        for (const update of updates) {
            this.offset = update.update_id + 1;
            if (update.message?.chat.type === 'private' && update.message.text) await this.answer(update.message);
        }
        return true;
    }

    private async answer(message: Message, now = new Date()) {
        const chatId = BigInt(message.chat.id);
        const text = message.text!.trim();
        const start = /^\/start(?:@\w+)?(?:\s+([\w-]{1,64}))?$/.exec(text);
        if (start?.[1]) {
            const linked = await this.link(chatId, start[1], now);
            const t = botTranslator(linked?.locale ?? localeOf(message.from?.language_code));
            return this.reply(chatId, linked ? t('replies.linked', { wallet: linked.wallet }) : t('replies.expired'));
        }
        if (/^\/unlink(?:@\w+)?$/.test(text)) {
            const revoked = await this.db
                .update(telegramLinks)
                .set({ revokedAt: now })
                .where(and(eq(telegramLinks.chatId, chatId), isNull(telegramLinks.revokedAt)))
                .returning({ locale: telegramLinks.locale });
            const t = botTranslator(revoked[0]?.locale ?? localeOf(message.from?.language_code));
            return this.reply(chatId, revoked.length ? t('replies.unlinked') : t('replies.notLinked'));
        }
        return this.reply(chatId, botTranslator(localeOf(message.from?.language_code))('replies.welcome'));
    }

    /** Spends the request whose token is `token`, unexpired and unused, and links `chatId` to its wallet. */
    private link(chatId: bigint, token: string, now: Date) {
        return this.db.transaction(async tx => {
            const [request] = await tx
                .update(telegramLinkRequests)
                .set({ usedAt: now })
                .where(
                    and(
                        eq(telegramLinkRequests.tokenHash, linkTokenHash(token)),
                        isNull(telegramLinkRequests.usedAt),
                        gt(telegramLinkRequests.expiresAt, now),
                    ),
                )
                .returning();
            if (!request) return null;
            const link = {
                linkedAt: now,
                locale: request.locale,
                messageSignature: request.signature,
                revokedAt: null,
            };
            await tx
                .insert(telegramLinks)
                .values({ ...link, chatId, wallet: request.wallet })
                .onConflictDoUpdate({ set: link, target: [telegramLinks.wallet, telegramLinks.chatId] });
            this.log.info({ chatId: String(chatId), wallet: request.wallet }, 'telegram chat linked');
            return request;
        });
    }

    private async reply(chatId: bigint, text: string) {
        await this.api('sendMessage', { chat_id: Number(chatId), text });
    }
}
