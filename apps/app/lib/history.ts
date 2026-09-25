import 'server-only';

import { attestations, type Database, sweeps, userEvents } from '@laterite/db/database';
import { desc, eq } from 'drizzle-orm';

/** The payment tokens by index (6 decimals) and the assets (xStocks, 8 decimals), as `Config` lists them. */
export const PAYMENT_TOKENS = ['USDC', 'USDT'] as const;
export const ASSETS = ['SPYx', 'QQQx'] as const;
const PAYMENT_DECIMALS = 6;
const ASSET_DECIMALS = 8;

export type Purchase = {
    asset: string;
    /** Asset received in UI units: raw × the multiplier the indexer recorded for the block time. */
    assetAmount: number;
    blockTime: Date;
    multiplier: number;
    /** Dollars pulled: the schedule's part and the part that waited to invest. */
    paid: number;
    /** What the user paid per UI token on their own swap: never Pyth's price. */
    price: number;
    signature: string;
    token: string;
};

export type Income = {
    amount: number;
    blockTime: Date;
    /** What the rule added to "to invest", and the total waiting after it. */
    invested: number;
    kind: 'income' | 'payment';
    pendingAfter: number;
    signature: string;
    sourceSignature: string;
    token: string;
};

export type Control = { blockTime: Date; kind: string; signature: string };

export type History = { controls: Control[]; incomes: Income[]; invested: number; purchases: Purchase[] };

const dollars = (raw: bigint) => Number(raw) / 10 ** PAYMENT_DECIMALS;

/** A wallet's purchases, attested incomes and payments, and controls, newest first, from the indexer's tables. */
export async function readHistory(db: Database, wallet: string): Promise<History> {
    const [swept, attested, controls] = await Promise.all([
        db.select().from(sweeps).where(eq(sweeps.user, wallet)).orderBy(desc(sweeps.blockTime)),
        db.select().from(attestations).where(eq(attestations.user, wallet)).orderBy(desc(attestations.blockTime)),
        db
            .select({ blockTime: userEvents.blockTime, kind: userEvents.kind, signature: userEvents.signature })
            .from(userEvents)
            .where(eq(userEvents.user, wallet))
            .orderBy(desc(userEvents.blockTime)),
    ]);
    const purchases = swept.map(row => {
        const paid = dollars(row.engine + row.pending);
        const assetAmount = (Number(row.received) / 10 ** ASSET_DECIMALS) * row.multiplier;
        return {
            asset: ASSETS[row.asset] ?? `asset ${row.asset}`,
            assetAmount,
            blockTime: row.blockTime,
            multiplier: row.multiplier,
            paid,
            price: assetAmount > 0 ? paid / assetAmount : 0,
            signature: row.signature,
            token: PAYMENT_TOKENS[row.paymentToken] ?? `token ${row.paymentToken}`,
        };
    });
    return {
        controls,
        incomes: attested.map(row => ({
            amount: dollars(row.amount),
            blockTime: row.blockTime,
            invested: dollars(row.invested),
            kind: row.kind,
            pendingAfter: dollars(row.pendingAfter),
            signature: row.signature,
            sourceSignature: row.sourceSignature,
            token: PAYMENT_TOKENS[row.paymentToken] ?? `token ${row.paymentToken}`,
        })),
        invested: purchases.reduce((total, purchase) => total + purchase.paid, 0),
        purchases,
    };
}

const cell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** The purchases as CSV (RFC 4180, `\r\n`): date, token, amount, price, asset, multiplier, link. */
export function purchasesCsv(purchases: Purchase[], explorer: (signature: string) => string): string {
    const rows = [
        ['date', 'token', 'amount', 'price', 'asset', 'multiplier', 'link'],
        ...purchases.map(purchase => [
            purchase.blockTime.toISOString(),
            purchase.token,
            purchase.paid.toFixed(2),
            purchase.price.toFixed(4),
            `${purchase.assetAmount.toFixed(8)} ${purchase.asset}`,
            String(purchase.multiplier),
            explorer(purchase.signature),
        ]),
    ];
    return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** A transaction's page on Solana Explorer, on devnet. */
export const explorerUrl = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
