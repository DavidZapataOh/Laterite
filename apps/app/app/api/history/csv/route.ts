import { isAddress } from '@solana/kit';
import { type NextRequest, NextResponse } from 'next/server';
import { database } from '@/lib/db';
import { explorerUrl, purchasesCsv, readHistory } from '@/lib/history';

/** A wallet's purchases as a CSV download, with the execution price only. */
export async function GET(request: NextRequest) {
    const wallet = request.nextUrl.searchParams.get('wallet');
    if (!wallet || !isAddress(wallet)) {
        return NextResponse.json({ error: 'wallet is not an address' }, { status: 400 });
    }
    const { purchases } = await readHistory(database(), wallet);
    return new NextResponse(purchasesCsv(purchases, explorerUrl), {
        headers: {
            'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="laterite-${wallet.slice(0, 8)}.csv"`,
            'Content-Type': 'text/csv; charset=utf-8',
        },
    });
}
