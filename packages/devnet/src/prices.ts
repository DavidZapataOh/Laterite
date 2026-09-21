import type { Address } from '@solana/kit';

import { MAINNET_MINTS, type PoolName } from './assets';

const PRICE_API = 'https://api.jup.ag/price/v3';

type JupiterPrice = { usdPrice: number; scaledUiConfig?: { usdPricePrescaled: number } };

export type UsdPrices = { SPYx: number; QQQx: number; USDT: number };

/** Live mainnet USD prices: xStocks per raw token unit (before ScaledUiAmount), USDT per token. */
export async function fetchUsdPrices(): Promise<UsdPrices> {
    const ids = [MAINNET_MINTS.SPYx, MAINNET_MINTS.QQQx, MAINNET_MINTS.USDT];
    const apiKey = process.env.JUPITER_API_KEY;
    const response = await fetch(`${PRICE_API}?ids=${ids.join(',')}`, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
    });
    if (!response.ok) throw new Error(`Jupiter Price API returned ${response.status}`);
    const body = (await response.json()) as Record<string, JupiterPrice | undefined>;
    const read = (mint: Address, prescaled: boolean) => {
        const price = body[mint];
        const value = prescaled ? price?.scaledUiConfig?.usdPricePrescaled : price?.usdPrice;
        if (value === undefined) throw new Error(`Jupiter Price API has no price for ${mint}`);
        return value;
    };
    return {
        QQQx: read(MAINNET_MINTS.QQQx, true),
        SPYx: read(MAINNET_MINTS.SPYx, true),
        USDT: read(MAINNET_MINTS.USDT, false),
    };
}

/** Target price of each pool in quote per whole base unit; USDC is taken at one dollar. */
export function poolTargets(prices: UsdPrices): Record<PoolName, number> {
    return {
        'QQQx-USDC': prices.QQQx,
        'QQQx-USDT': prices.QQQx / prices.USDT,
        'SPYx-USDC': prices.SPYx,
        'SPYx-USDT': prices.SPYx / prices.USDT,
    };
}
