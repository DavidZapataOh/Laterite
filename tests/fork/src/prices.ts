import { fetchPythStorage, quote, verifyPythUpdate } from '@laterite/client';
import { fetchLatestKaminoUpdate, fetchPythProUpdate, PYTH_USDT_FEED_ID } from '@laterite/client/node';
import type { ReadonlyUint8Array } from '@solana/kit';

import { alignClock, clock, mainnetRpc, rpc } from './fork';

// An update must still be fresh when the sweep lands: the crank's margin inside the program's 60 s.
const MAX_AGE_SECONDS = 45n;
// Kamino Scope posts about every 40 s: an update too old to land in time means waiting for its next post.
const KAMINO_POLL_MS = 10_000;
const KAMINO_POLLS = 6;

const latest = new Map<number, ReadonlyUint8Array>();

const isFresh = (update: ReadonlyUint8Array | undefined, feedId: number, now: bigint) => {
    try {
        return update !== undefined && quote(update, feedId, now, MAX_AGE_SECONDS) !== undefined;
    } catch {
        return false;
    }
};

/**
 * The price updates a sweep carries, as the crank obtains them: the asset's from Kamino Scope's latest mainnet post
 * (kept while its feed is at most 45 s old at the fork's clock, else Scope's next post is awaited) and, for USDT, a
 * USDT/USD update fetched with the access token; each checked against the fork's Pyth Pro storage. The fork's clock
 * is aligned to wall time first.
 */
export async function priceUpdates(assetFeedId: number, paymentFeedId: number) {
    const clockDrift = await alignClock();
    const storage = await fetchPythStorage(rpc);
    let asset = latest.get(assetFeedId);
    for (let poll = 0; !isFresh(asset, assetFeedId, await clock()); poll++) {
        if (poll === KAMINO_POLLS) throw new Error(`Kamino Scope posted no fresh update of feed ${assetFeedId}`);
        if (poll > 0) await new Promise(resolve => setTimeout(resolve, KAMINO_POLL_MS));
        asset = (await fetchLatestKaminoUpdate(mainnetRpc, assetFeedId)).message;
    }
    latest.set(assetFeedId, asset!);
    const now = await clock();
    await verifyPythUpdate(asset!, storage, now);
    let payment: ReadonlyUint8Array | undefined;
    if (paymentFeedId !== 0) {
        const accessToken = process.env.PYTH_PRO_ACCESS_TOKEN;
        if (!accessToken) throw new Error('PYTH_PRO_ACCESS_TOKEN is required for a USDT sweep');
        payment = await fetchPythProUpdate({ accessToken, priceFeedIds: [PYTH_USDT_FEED_ID] });
        await verifyPythUpdate(payment, storage, now);
    }
    return { asset: asset!, clockDrift, payment, treasury: storage.treasury };
}
