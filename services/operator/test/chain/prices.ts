import type { Quote } from '@laterite/client';
import type { ReadonlyUint8Array } from '@solana/kit';

import type { PriceUpdates, TimedUpdate } from '../../src/crank/prices';
import { pythUpdate } from './chain';
import { SPYX_QUOTE } from './validator';

/** USDT/USD at $1.0001 within a basis point, in Pyth Pro's units. */
export const USDT_QUOTE: Quote = { confidence: 10_000n, exponent: -8, price: 100_010_000n };

/**
 * The price updates a sweep carries, composed at the cluster's clock and signed by the key the local Pyth Pro storage
 * trusts, in place of Kamino Scope's relayed posts and Pyth Pro's token-fetched updates. A test can withhold or age the
 * asset update, widen its confidence or leave out its feed.
 */
export class TestPrices implements PriceUpdates {
    /** Seconds the asset update is older than the clock it is asked at. */
    assetAge = 0n;
    /** No fresh post came within the wait, as the relay answers when Kamino Scope is late. */
    assetMissing = false;
    assetQuote: Quote = SPYX_QUOTE;
    /** The feed the asset update carries in place of the one asked for. */
    assetFeed: number | undefined;
    paymentQuote: Quote = USDT_QUOTE;
    readonly latest = new Map<number, TimedUpdate>();
    asked = 0;

    async asset(feedId: number, now: bigint) {
        this.asked += 1;
        if (this.assetMissing) return null;
        const updatedAt = now - this.assetAge;
        const message = await pythUpdate(updatedAt, [[this.assetFeed ?? feedId, this.assetQuote]]);
        this.latest.set(feedId, { message, updatedAt });
        return { message, updatedAt, waitedMs: 0 };
    }

    async payment(feedId: number, now: bigint): Promise<ReadonlyUint8Array> {
        return pythUpdate(now, [[feedId, this.paymentQuote]]);
    }

    /** Healthy updates again. */
    reset() {
        this.assetAge = 0n;
        this.assetMissing = false;
        this.assetQuote = SPYX_QUOTE;
        this.assetFeed = undefined;
        this.paymentQuote = USDT_QUOTE;
    }
}
