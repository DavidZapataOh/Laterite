import { getBase16Encoder, type ReadonlyUint8Array } from '@solana/kit';

/** Pyth Pro's price service. */
export const PYTH_PRO_PRICE_SERVICE_URL = 'https://pyth-lazer.dourolabs.app';

/** Pyth Pro's USDT/USD feed. */
export const PYTH_USDT_FEED_ID = 8;

/**
 * The latest Solana-format update of `priceFeedIds` from Pyth Pro's `/v1/latest_price`, with the properties the
 * program reads (price, exponent, confidence, feed update time) on the `fixed_rate@200ms` channel. Server-only: the
 * access token never reaches a browser.
 */
export async function fetchPythProUpdate(input: {
    accessToken: string;
    fetch?: typeof globalThis.fetch;
    priceFeedIds: readonly number[];
    priceServiceUrl?: string;
}): Promise<ReadonlyUint8Array> {
    const response = await (input.fetch ?? globalThis.fetch)(
        `${input.priceServiceUrl ?? PYTH_PRO_PRICE_SERVICE_URL}/v1/latest_price`,
        {
            body: JSON.stringify({
                channel: 'fixed_rate@200ms',
                formats: ['solana'],
                jsonBinaryEncoding: 'hex',
                priceFeedIds: input.priceFeedIds,
                properties: ['price', 'exponent', 'confidence', 'feedUpdateTimestamp'],
            }),
            headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
            method: 'POST',
        },
    );
    if (!response.ok) throw new Error(`Pyth Pro latest_price ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { solana?: { data: string; encoding: string } };
    if (body.solana?.encoding !== 'hex') throw new Error('Pyth Pro returned no Solana-format update');
    return getBase16Encoder().encode(body.solana.data);
}
