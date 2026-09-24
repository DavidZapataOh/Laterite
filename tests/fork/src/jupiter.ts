/**
 * Classic pools only: their whole state lives in accounts the fork clones, while market makers' quotes depend on
 * accounts their operators update every few slots, which go stale on a fork.
 */
export const CLASSIC_DEXES = ['Raydium CLMM', 'Whirlpool'];

const apiKey = process.env.JUPITER_API_KEY || undefined;
// Keyless access allows 0.5 requests a second, a free key 1.
const SPACING_MS = apiKey ? 1_100 : 2_100;
let next = 0;

/** A `fetch` for Jupiter's API that keeps to its rate limit and backs off on a 429. */
export const jupiterFetch = (async (url: string, init?: RequestInit) => {
    for (let attempt = 0; ; attempt++) {
        const wait = next - Date.now();
        next = Math.max(next, Date.now()) + SPACING_MS * 2 ** attempt;
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        const response = await fetch(url, init);
        if (response.status !== 429 || attempt === 5) return response;
    }
}) as typeof globalThis.fetch;

export const jupiter = { apiKey, fetch: jupiterFetch };
