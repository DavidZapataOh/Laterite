import type { ConfigParamsArgs, SettingsArgs } from '@laterite/client';
import { JUPITER_PROGRAM_ADDRESS } from '@laterite/client/node';
import { DECIMALS, MAINNET_MINTS, PYTH_FEEDS } from '@laterite/devnet';
import { address, getBase58Encoder } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

import type { TokenMint } from './setup';

/** Wrapped SOL, which many Jupiter routes between the payment tokens and the assets pass through. */
export const WRAPPED_SOL_MINT = address('So11111111111111111111111111111111111111112');

/**
 * The mainnet configuration, which the mainnet-fork suite deploys: Jupiter as the router, the xStocks (SPYx, QQQx,
 * Token-2022) and the payment tokens (USDC at one dollar, USDT priced by its Pyth Pro feed) in table order, the given
 * settings, and the genesis hash of the cluster being deployed to, as its RPC's `getGenesisHash` returns it.
 */
export function mainnetConfigParams(input: { genesisHash: string; settings: SettingsArgs }): ConfigParamsArgs {
    const asset = (symbol: 'QQQx' | 'SPYx') => ({
        decimals: DECIMALS[symbol],
        mint: MAINNET_MINTS[symbol],
        pythFeedId: PYTH_FEEDS[symbol].proId,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const payment = (symbol: 'USDC' | 'USDT', usdFeedId: number) => ({
        decimals: DECIMALS[symbol],
        mint: MAINNET_MINTS[symbol],
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        usdFeedId,
    });
    return {
        assets: [asset('SPYx'), asset('QQQx')],
        genesisHash: getBase58Encoder().encode(input.genesisHash),
        paymentTokens: [payment('USDC', 0), payment('USDT', PYTH_FEEDS.USDT.proId)],
        router: JUPITER_PROGRAM_ADDRESS,
        settings: input.settings,
    };
}

/**
 * The swap authority's accounts Jupiter routes name besides the payment tokens' (ADR-001): each asset, since a route
 * passes its output through the taker's own account and QQQx routes hop through SPYx, and wrapped SOL, the other
 * intermediate classic-pool routes take. A route through any other intermediate needs an account the swap authority
 * lacks: `buildJupiterSweepRoute` names it in `SwapAuthorityAccountsRequiredError`, for the caller to create before
 * building again.
 */
export const JUPITER_ROUTE_MINTS: TokenMint[] = [
    { mint: MAINNET_MINTS.SPYx, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
    { mint: MAINNET_MINTS.QQQx, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
    { mint: WRAPPED_SOL_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS },
];
