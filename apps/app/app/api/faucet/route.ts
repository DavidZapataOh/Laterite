import { isAddress } from '@solana/kit';
import { ipAddress } from '@vercel/functions';
import { type NextRequest, NextResponse } from 'next/server';
import { database, isDeclared } from '@/lib/db';
import { FAUCET_AMOUNT, faucetSigner, reserveGrant, sendFaucet, settleGrant } from '@/lib/faucet';
import { isBlocked, requestRegion } from '@/lib/geo';

const headers = { 'Cache-Control': 'no-store' };
const refuse = (error: string, status: number, extra: Record<string, string> = {}) =>
    NextResponse.json({ error }, { headers: { ...headers, ...extra }, status });

/**
 * The devnet faucet: mints $100 of test USDC and $100 of test USDT to a declared wallet, creating its accounts, the
 * faucet key paying. One grant per wallet and three per requesting address in 24 hours, counted in Postgres.
 */
export async function POST(request: NextRequest) {
    if (isBlocked(requestRegion(request.headers))) return refuse('unavailable', 451);
    const text = await request.text();
    if (text.length > 256) return refuse('the body is too large', 413);
    let wallet: unknown;
    try {
        ({ wallet } = JSON.parse(text) ?? {});
    } catch {
        return refuse('the body is not JSON', 400);
    }
    if (typeof wallet !== 'string' || !isAddress(wallet)) return refuse('wallet is not an address', 400);
    const db = database();
    if (!(await isDeclared(db, wallet))) return refuse('the wallet has not declared its eligibility', 403);
    const reservation = await reserveGrant(db, wallet, ipAddress(request) ?? null);
    if ('retryAfterSeconds' in reservation) {
        return refuse('the faucet already funded this wallet or address today', 429, {
            'Retry-After': String(reservation.retryAfterSeconds),
        });
    }
    try {
        const signature = await sendFaucet(await faucetSigner(), wallet);
        await settleGrant(db, reservation.id, signature);
        return NextResponse.json({ amount: String(FAUCET_AMOUNT), signature }, { headers, status: 201 });
    } catch (error) {
        await settleGrant(db, reservation.id, null);
        console.error('the faucet could not mint', error);
        return refuse('the faucet could not mint', 502);
    }
}
