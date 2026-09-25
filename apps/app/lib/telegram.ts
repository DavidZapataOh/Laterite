import { createHash, randomBytes } from 'node:crypto';

/** How long a link request's bot link works: the wallet signs, then opens Telegram and starts the bot. */
export const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;

/** The `bot.link` messages of one locale, as next-intl's translators on the client and the server give them. */
export type TelegramLinkTranslator = (
    key: 'heading' | 'request' | 'unlink' | 'wallet' | 'issuedAt',
    values?: Record<string, string>,
) => string;

export type TelegramLinkRequest = { domain: string; wallet: string; issuedAt: string };

/** The exact text a wallet signs to link a Telegram chat, or to unlink every chat, on the client and the server. */
export function telegramLinkMessage(
    t: TelegramLinkTranslator,
    action: 'link' | 'unlink',
    { domain, wallet, issuedAt }: TelegramLinkRequest,
): string {
    return [
        t('heading'),
        t(action === 'link' ? 'request' : 'unlink', { domain }),
        t('wallet', { wallet }),
        t('issuedAt', { issuedAt }),
    ].join('\n');
}

/** A one-time token for the bot's start link (43 URL-safe characters) and the SHA-256 the database keeps of it. */
export function linkToken(): { hash: string; token: string } {
    const token = randomBytes(32).toString('base64url');
    return { hash: createHash('sha256').update(token).digest('hex'), token };
}
