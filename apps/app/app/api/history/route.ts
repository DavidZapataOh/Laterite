import { isAddress } from '@solana/kit';
import { type NextRequest, NextResponse } from 'next/server';
import { database } from '@/lib/db';
import { readHistory } from '@/lib/history';

/** A wallet's history from the indexer: public on-chain data, never cached, so a new purchase shows at once. */
export async function GET(request: NextRequest) {
    const wallet = request.nextUrl.searchParams.get('wallet');
    if (!wallet || !isAddress(wallet)) {
        return NextResponse.json({ error: 'wallet is not an address' }, { status: 400 });
    }
    return NextResponse.json(await readHistory(database(), wallet), { headers: { 'Cache-Control': 'no-store' } });
}
