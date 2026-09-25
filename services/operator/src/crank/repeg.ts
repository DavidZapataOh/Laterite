import { type Quote, quote } from '@laterite/client';
import {
    type DevnetAddresses,
    fetchUsdPrices,
    type PoolName,
    poolTargets,
    repeg,
    type UsdPrices,
} from '@laterite/devnet';
import type { Address, GetAccountInfoApi, GetTokenAccountBalanceApi, Rpc, Signature } from '@solana/kit';

import type { Logger } from '../log';
import type { Sender } from '../send';
import { MAX_ASSET_UPDATE_AGE_SECONDS, type TimedUpdate } from './prices';

/** A Pyth price in dollars: `price × 10^exponent`, per raw whole token for the xStocks (no ScaledUiAmount multiplier). */
export const dollars = ({ exponent, price }: Quote) => Number(price) * 10 ** exponent;

/** The devnet pool that swaps `payment` into `asset`, by their mints. */
export function devnetPool(addresses: Pick<DevnetAddresses, 'pools' | 'tokens'>, asset: Address, payment: Address) {
    const found = Object.entries(addresses.pools).find(
        ([, { base, quote }]) => addresses.tokens[base].mint === asset && addresses.tokens[quote].mint === payment,
    );
    return found?.[0] as PoolName | undefined;
}

/** Whether `repeg()` refused to trade a pool further than 500 bps from its target. */
export const isRepegRefusal = (error: unknown): error is Error =>
    error instanceof Error && error.message.includes('refusing to re-peg');

/**
 * Keeps devnet's CPMM pools at Pyth's prices, trading from the treasury within `REPEG_TOLERANCE_BPS` (10): every run,
 * each pool at the prices of the latest fresh updates (the relayed asset update, a token-fetched USDT update for the
 * USDT pools), or at Jupiter's keyless prices while no fresh Pyth update is available; and right before each sweep, the
 * sweep's pool at the prices of the updates the sweep carries, so the pool and `min_out` agree. A pool further than
 * 500 bps from its target is refused by `repeg()` and alarmed, never traded.
 */
export class Repegger {
    constructor(
        private readonly input: {
            addresses: DevnetAddresses;
            /** Jupiter's keyless prices, used only while no fresh Pyth update is available. */
            fallbackPrices?: () => Promise<UsdPrices>;
            log: Logger;
            /** The latest relayed update of each asset feed. */
            assetUpdates: () => ReadonlyMap<number, TimedUpdate>;
            /** A fresh USDT/USD update. */
            usdtUpdate: (now: bigint) => Promise<TimedUpdate['message']>;
            pools: readonly PoolName[];
            rpc: Rpc<GetAccountInfoApi & GetTokenAccountBalanceApi>;
            /** The treasury's sender: it signs the trades and pays their fees. */
            treasury: Sender;
        },
    ) {}

    /** Re-pegs every pool; returns the alarm states of the pools the re-peg refused. */
    async tick(now: bigint): Promise<Record<string, string | null>> {
        const targets = await this.targets(now);
        const states: Record<string, string | null> = {};
        for (const pool of this.input.pools) {
            states[`repeg-${pool}`] = null;
            try {
                await this.trade(pool, targets.get(pool)!);
            } catch (error) {
                if (!isRepegRefusal(error)) throw error;
                states[`repeg-${pool}`] =
                    `${(error as Error).message}: the devnet pool is not traded; check the treasury's inventory and the price sources`;
            }
        }
        return states;
    }

    /**
     * Re-pegs the pool that swaps `paymentMint` into `assetMint` to the prices of a sweep's updates; `payment` is `null`
     * for a token at one dollar.
     */
    async before(
        assetMint: Address,
        paymentMint: Address,
        asset: Quote,
        payment: Quote | null,
    ): Promise<Signature | null> {
        const pool = devnetPool(this.input.addresses, assetMint, paymentMint);
        if (!pool) throw new Error(`No devnet pool swaps ${paymentMint} into ${assetMint}`);
        return this.trade(pool, dollars(asset) / (payment ? dollars(payment) : 1));
    }

    private async trade(pool: PoolName, targetPrice: number) {
        const { addresses, log, rpc, treasury } = this.input;
        const signature = await repeg({
            addresses,
            client: {
                rpc,
                send: async (payer, instructions) => {
                    if (payer.address !== treasury.payer.address)
                        throw new Error('The re-peg trades from the treasury');
                    return treasury.send(await treasury.build(instructions));
                },
            },
            pool,
            targetPrice,
            treasury: treasury.payer,
        });
        if (signature) log.info({ pool, signature, targetPrice }, 'pool re-pegged');
        return signature;
    }

    /** Each pool's target from fresh Pyth updates, else from Jupiter's prices. */
    private async targets(now: bigint): Promise<Map<PoolName, number>> {
        const { addresses, assetUpdates, fallbackPrices = fetchUsdPrices, log, pools, usdtUpdate } = this.input;
        const fresh = (message: TimedUpdate['message'] | undefined, feedId: number) => {
            try {
                return message && quote(message, feedId, now, MAX_ASSET_UPDATE_AGE_SECONDS);
            } catch {
                return undefined;
            }
        };
        const usdtFeed = addresses.tokens.USDT.pyth!.proId;
        const usdt = pools.some(pool => addresses.pools[pool].quote === 'USDT')
            ? fresh(await usdtUpdate(now).catch(() => undefined), usdtFeed)
            : undefined;
        const updates = assetUpdates();
        const targets = new Map<PoolName, number>();
        let fallback: Record<PoolName, number> | undefined;
        for (const pool of pools) {
            const { base, quote: payment } = addresses.pools[pool];
            const feedId = addresses.tokens[base].pyth!.proId;
            const asset = fresh(updates.get(feedId)?.message, feedId);
            const dollar = payment === 'USDC' ? 1 : usdt && dollars(usdt);
            if (asset && dollar) {
                targets.set(pool, dollars(asset) / dollar);
                continue;
            }
            log.warn({ pool }, 'no fresh Pyth update for the pool: re-pegging at Jupiter prices');
            fallback ??= poolTargets(await fallbackPrices());
            targets.set(pool, fallback[pool]);
        }
        return targets;
    }
}
