import { isAddress } from '@solana/kit';
import { and, eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { createTranslator } from 'next-intl';
import { eligibilityDeclarations } from '@laterite/db/database';
import { isLocale } from '@laterite/i18n';
import { database } from '@/lib/db';
import {
    DECLARATION_VERSION,
    declarationMessage,
    declarationProblem,
    type DeclarationTranslator,
} from '@/lib/declaration';
import { isBlocked, requestRegion } from '@/lib/geo';

const headers = { 'Cache-Control': 'no-store' };
const refuse = (error: string, status: number) => NextResponse.json({ error }, { headers, status });

/** A declaration is a few hundred bytes; anything larger is refused unread. */
const MAX_BODY = 4096;

/** Whether `?wallet=` has declared the current version. */
export async function GET(request: NextRequest) {
    const wallet = request.nextUrl.searchParams.get('wallet');
    if (!wallet || !isAddress(wallet)) return refuse('wallet is not an address', 400);
    const [row] = await database()
        .select({ wallet: eligibilityDeclarations.wallet })
        .from(eligibilityDeclarations)
        .where(
            and(
                eq(eligibilityDeclarations.wallet, wallet),
                eq(eligibilityDeclarations.declarationVersion, DECLARATION_VERSION),
            ),
        )
        .limit(1);
    return NextResponse.json({ declared: row !== undefined, version: DECLARATION_VERSION }, { headers });
}

/**
 * Records a wallet's signed declaration of the current version with the country its request came from. The text is
 * rebuilt here from the locale, this host, the wallet and the issue time, and the wallet's signature must match it.
 */
export async function POST(request: NextRequest) {
    const where = requestRegion(request.headers);
    if (isBlocked(where)) return refuse('unavailable', 451);
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
    const t = createTranslator({ locale, messages, namespace: 'declaration' }) as DeclarationTranslator;
    // the host the page was served from, which the wallet showed in the text it signed
    const declaration = { domain: request.headers.get('host') ?? request.nextUrl.host, issuedAt, signature, wallet };
    const problem = await declarationProblem(t, declaration);
    if (problem) return refuse(problem, 400);
    await database()
        .insert(eligibilityDeclarations)
        .values({
            country: where.country,
            declarationVersion: DECLARATION_VERSION,
            message: declarationMessage(t, declaration),
            signature,
            wallet,
        })
        .onConflictDoNothing();
    return NextResponse.json({ declared: true, version: DECLARATION_VERSION }, { headers, status: 201 });
}
