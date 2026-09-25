import { isAddress } from '@solana/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { createTranslator } from 'next-intl';
import { telegramLinkRequests, telegramLinks } from '@laterite/db/database';
import { isLocale, type Locale } from '@laterite/i18n';
import { database } from '@/lib/db';
import { signatureProblem, type SignedText } from '@/lib/signed';
import { LINK_TOKEN_TTL_MS, linkToken, telegramLinkMessage, type TelegramLinkTranslator } from '@/lib/telegram';

const headers = { 'Cache-Control': 'no-store' };
const refuse = (error: string, status: number) => NextResponse.json({ error }, { headers, status });

/** A signed request is a few hundred bytes; anything larger is refused unread. */
const MAX_BODY = 4096;

type Signed = SignedText & { locale: Locale; message: string };

/**
 * The signed request in `request`'s body, checked against the text rebuilt here from the locale, this host, the
 * wallet and the issue time, or the response refusing it.
 */
async function signedRequest(request: NextRequest, action: 'link' | 'unlink'): Promise<Signed | NextResponse> {
    const text = await request.text();
    if (text.length > MAX_BODY) return refuse('the body is too large', 413);
    let body: Record<string, unknown>;
    try {
        body = JSON.parse(text);
    } catch {
        return refuse('the body is not JSON', 400);
    }
    const { locale, wallet, issuedAt, signature } = body ?? {};
    if (!isLocale(locale)) return refuse('locale is not supported', 400);
    if (typeof wallet !== 'string' || typeof issuedAt !== 'string' || typeof signature !== 'string') {
        return refuse('wallet, issuedAt and signature are required', 400);
    }
    const messages = (await import(`@laterite/i18n/messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: 'bot.link' }) as TelegramLinkTranslator;
    // the host the page was served from, which the wallet showed in the text it signed
    const domain = request.headers.get('host') ?? request.nextUrl.host;
    const message = telegramLinkMessage(t, action, { domain, issuedAt, wallet });
    const problem = await signatureProblem({ issuedAt, signature, wallet }, message);
    return problem ? refuse(problem, 400) : { issuedAt, locale, message, signature, wallet };
}

/** Whether `?wallet=` has a chat linked. */
export async function GET(request: NextRequest) {
    const wallet = request.nextUrl.searchParams.get('wallet');
    if (!wallet || !isAddress(wallet)) return refuse('wallet is not an address', 400);
    const [row] = await database()
        .select({ chatId: telegramLinks.chatId })
        .from(telegramLinks)
        .where(and(eq(telegramLinks.wallet, wallet), isNull(telegramLinks.revokedAt)))
        .limit(1);
    return NextResponse.json({ linked: row !== undefined }, { headers });
}

/**
 * Records a wallet's signed link request and answers the bot's start link carrying its one-time token: the chat that
 * opens it within {@link LINK_TOKEN_TTL_MS} is linked to the wallet.
 */
export async function POST(request: NextRequest) {
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    if (!bot) return refuse('Telegram is not configured', 503);
    const signed = await signedRequest(request, 'link');
    if (signed instanceof NextResponse) return signed;
    const { hash, token } = linkToken();
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);
    const [created] = await database()
        .insert(telegramLinkRequests)
        .values({
            expiresAt,
            locale: signed.locale,
            message: signed.message,
            signature: signed.signature,
            tokenHash: hash,
            wallet: signed.wallet,
        })
        .onConflictDoNothing({ target: telegramLinkRequests.signature })
        .returning({ tokenHash: telegramLinkRequests.tokenHash });
    if (!created) return refuse('the signature was already used', 409);
    return NextResponse.json(
        { expiresAt: expiresAt.toISOString(), link: `https://t.me/${bot}?start=${token}` },
        { headers, status: 201 },
    );
}

/** Revokes every chat linked to a wallet on its signed unlink request. */
export async function DELETE(request: NextRequest) {
    const signed = await signedRequest(request, 'unlink');
    if (signed instanceof NextResponse) return signed;
    await database()
        .update(telegramLinks)
        .set({ revokedAt: new Date() })
        .where(and(eq(telegramLinks.wallet, signed.wallet), isNull(telegramLinks.revokedAt)));
    return NextResponse.json({ linked: false }, { headers });
}
