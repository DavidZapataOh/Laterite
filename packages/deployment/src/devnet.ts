import { type ConfigParamsArgs, TIERS } from '@laterite/client';
import { addresses as devnet } from '@laterite/devnet/addresses';
import { type Address, getBase58Encoder } from '@solana/kit';

/** The devnet beta: at most 1,000 users, each within the $25 tier. */
export const DEVNET_SETTINGS = { maxUsers: 1_000, userWeeklyCap: TIERS[1] };

/**
 * The devnet configuration: our CPMM as the router, the stand-in assets (SPYx, QQQx) and payment tokens (USDC at one
 * dollar, USDT priced by its Pyth Pro feed) in table order, devnet's own attestor and sponsor keys, and the genesis
 * hash of the cluster being deployed to, as its RPC's `getGenesisHash` returns it.
 */
export function devnetConfigParams(input: {
    attestor: Address;
    genesisHash: string;
    sponsor: Address;
}): ConfigParamsArgs {
    const { tokens } = devnet;
    const asset = (symbol: 'QQQx' | 'SPYx') => ({
        decimals: tokens[symbol].decimals,
        mint: tokens[symbol].mint,
        pythFeedId: tokens[symbol].pyth!.proId,
        tokenProgram: tokens[symbol].tokenProgram,
    });
    const payment = (symbol: 'USDC' | 'USDT') => ({
        decimals: tokens[symbol].decimals,
        mint: tokens[symbol].mint,
        tokenProgram: tokens[symbol].tokenProgram,
        usdFeedId: tokens[symbol].pyth?.proId ?? 0,
    });
    return {
        assets: [asset('SPYx'), asset('QQQx')],
        genesisHash: getBase58Encoder().encode(input.genesisHash),
        paymentTokens: [payment('USDC'), payment('USDT')],
        router: devnet.cpmm.program,
        settings: { ...DEVNET_SETTINGS, attestor: input.attestor, sponsor: input.sponsor },
    };
}
