import { type Config, fetchConfig, findConfigPda, type UserConfig } from '@laterite/client';
import { findAssociatedTokenPda } from '@solana-program/token';
import type { Address, GetAccountInfoApi, GetTokenAccountBalanceApi, Rpc } from '@solana/kit';

/** Laterite's `Config` and the user's position in their asset, in UI units as the RPC reports them (ScaledUiAmount). */
export type Position = { amount: number; config: Config };

export async function readPosition(
    rpc: Rpc<GetAccountInfoApi & GetTokenAccountBalanceApi>,
    user: Address,
    userConfig: UserConfig,
    abortSignal?: AbortSignal,
): Promise<Position> {
    const { data: config } = await fetchConfig(rpc, (await findConfigPda())[0], {
        abortSignal,
        commitment: 'confirmed',
    });
    const asset = config.assets[userConfig.asset];
    if (!asset) return { amount: 0, config };
    const [account] = await findAssociatedTokenPda({ mint: asset.mint, owner: user, tokenProgram: asset.tokenProgram });
    try {
        const { value } = await rpc.getTokenAccountBalance(account, { commitment: 'confirmed' }).send({ abortSignal });
        return { amount: Number(value.uiAmountString ?? '0'), config };
    } catch {
        // no account yet: nothing bought
        return { amount: 0, config };
    }
}
