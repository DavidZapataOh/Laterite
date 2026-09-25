import { fetchConfig, findConfigPda, LateriteCheckError, RestoreRequiredError } from '@laterite/client';
import { type Address, getBase64EncodedWireTransaction, isAddress } from '@solana/kit';
import { ipAddress } from '@vercel/functions';
import { type NextRequest, NextResponse } from 'next/server';
import { database, isDeclared } from '@/lib/db';
import { isBlocked, requestRegion } from '@/lib/geo';
import { closedReason, readIntentBody } from '@/lib/onboarding';
import {
    buildSponsored,
    logSponsor,
    onboardingLookupTable,
    prepareSponsored,
    shapeProblem,
    SponsorSimulationError,
    sponsorRpc,
    sponsorSigner,
} from '@/lib/sponsor';
import { assetAccountPaid, prepareLimit, recordPrepared } from '@/lib/sponsorships';

const headers = { 'Cache-Control': 'no-store' };

/** An intent and a wallet are a few hundred bytes; anything larger is refused unread. */
const MAX_BODY = 2048;

/**
 * Builds and simulates the sponsored transaction of an intent (onboarding or a return) for a declared wallet, the
 * route setting its compute-unit price and limit, and hands the unsigned message to the wallet with what the
 * simulation says. Nothing is signed or sent here; `/api/sponsor/submit` co-signs only this exact message.
 */
export async function POST(request: NextRequest) {
    const ip = ipAddress(request) ?? null;
    // who a refusal is logged for, once the request names a wallet
    const who: { wallet?: Address } = {};
    const refuse = (error: string, status: number, extra: Record<string, unknown> = {}, retryAfter?: number) => {
        logSponsor(status >= 500 ? 'error' : 'warn', 'sponsor refused to prepare', {
            error,
            ip,
            status,
            wallet: who.wallet,
            ...extra,
        });
        return NextResponse.json(
            { error, ...extra },
            { headers: retryAfter ? { ...headers, 'Retry-After': String(retryAfter) } : headers, status },
        );
    };
    if (isBlocked(requestRegion(request.headers))) return refuse('unavailable', 451);
    const text = await request.text();
    if (text.length > MAX_BODY) return refuse('invalid', 413);
    let body: { intent?: unknown; wallet?: unknown };
    try {
        body = JSON.parse(text) ?? {};
    } catch {
        return refuse('invalid', 400);
    }
    const intent = readIntentBody(body.intent);
    if (typeof body.wallet !== 'string' || !isAddress(body.wallet) || !intent) return refuse('invalid', 400);
    const wallet = (who.wallet = body.wallet);
    const db = database();
    if (!(await isDeclared(db, wallet))) return refuse('undeclared', 403);
    const limited = await prepareLimit(db, wallet, ip, intent.kind);
    if (limited) return refuse('limited', 429, { limit: limited.limit }, limited.retryAfterSeconds);

    const { rpc } = sponsorRpc();
    const sponsor = await sponsorSigner();
    const { data: config } = await fetchConfig(rpc, (await findConfigPda())[0], { commitment: 'confirmed' });
    const closed = closedReason(config);
    if (closed) return refuse(closed, 409);
    if (config.sponsor !== sponsor.address) return refuse('sponsor', 503);

    let built;
    try {
        built = await buildSponsored({ config, intent, rpc, sponsor, wallet });
    } catch (error) {
        if (error instanceof LateriteCheckError) return refuse('check', 409, { code: error.code });
        if (error instanceof RestoreRequiredError) return refuse('frozen', 409);
        if (error instanceof Error && /has enrolled before/.test(error.message)) return refuse('enrolled', 409);
        if (error instanceof Error && /has no account in/.test(error.message)) return refuse('token-account', 409);
        throw error;
    }
    const asset = config.assets[intent.params.asset]!.mint;
    if (built.createsAssetAccount && (await assetAccountPaid(db, wallet, asset))) {
        return refuse('asset-account', 409, { asset });
    }
    const lookupTable = await onboardingLookupTable(rpc, config);
    let prepared;
    try {
        prepared = await prepareSponsored({ instructions: built.instructions, lookupTable, rpc, sponsor });
    } catch (error) {
        if (error instanceof SponsorSimulationError) return refuse('simulation', 422, { ...error.failure });
        throw error;
    }
    const shape = await shapeProblem(prepared.transaction, {
        config,
        kind: intent.kind,
        lookupTable,
        sponsor: sponsor.address,
        user: wallet,
    });
    if (shape) return refuse('shape', 500, { shape });
    await recordPrepared(db, {
        assetAccount: built.createsAssetAccount ? asset : null,
        computeUnitLimit: prepared.computeUnitLimit,
        computeUnitPrice: prepared.computeUnitPrice,
        computeUnits: prepared.computeUnits,
        ip,
        kind: intent.kind,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        message: prepared.messageHash,
        sponsorLamports: prepared.sponsorLamports,
        wallet,
    });
    return NextResponse.json(
        {
            simulation: {
                computeUnits: prepared.computeUnits,
                feeLamports: String(prepared.feeLamports),
                sponsorLamports: String(prepared.sponsorLamports),
                userLamports: String(prepared.userLamports),
            },
            transaction: getBase64EncodedWireTransaction(prepared.transaction),
        },
        { headers },
    );
}
