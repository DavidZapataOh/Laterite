import {
    type Address,
    Endian,
    getAddressEncoder,
    getProgramDerivedAddress,
    getU16Encoder,
    type GetAccountInfoApi,
    type GetTokenAccountBalanceApi,
    type Instruction,
    type ReadonlyUint8Array,
    type Rpc,
    type TransactionSigner,
} from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token-2022';

import type { PoolInfo, TokenInfo } from './addresses';
import type { TokenSymbol } from './assets';
import { fetchPoolState, getSwapBaseInputInstructionAsync, RAYDIUM_CP_SWAP_PROGRAM_ADDRESS } from './generated';
import type { PoolFees, Reserves } from './repeg';

export const AMM_CONFIG_INDEX = 0;

/** Raydium's mainnet AmmConfig 0 rates, in millionths: 0.25% trade fee, 12% protocol and 4% fund shares. */
export const POOL_FEES: PoolFees = { fundFeeRate: 40_000n, protocolFeeRate: 120_000n, tradeFeeRate: 2_500n };

const encoder = getAddressEncoder();

const pda = async (seeds: (string | ReadonlyUint8Array)[]) =>
    (await getProgramDerivedAddress({ programAddress: RAYDIUM_CP_SWAP_PROGRAM_ADDRESS, seeds }))[0];

export const ammConfigAddress = () =>
    pda(['amm_config', getU16Encoder({ endian: Endian.Big }).encode(AMM_CONFIG_INDEX)]);

export const poolAddress = (ammConfig: Address, token0: Address, token1: Address) =>
    pda(['pool', encoder.encode(ammConfig), encoder.encode(token0), encoder.encode(token1)]);

export const supportMintAddress = (mint: Address) => pda(['support_mint', encoder.encode(mint)]);

/** Orders two mints by their bytes, the order CPMM requires for token 0 and token 1. */
export function orderMints(a: Address, b: Address): [Address, Address] {
    const x = encoder.encode(a);
    const y = encoder.encode(b);
    for (let i = 0; i < 32; i++) {
        if (x[i] !== y[i]) return x[i]! < y[i]! ? [a, b] : [b, a];
    }
    return [a, b];
}

/** Curve reserves: vault balances minus the fees the pool owes its owners. */
export async function poolReserves(
    rpc: Rpc<GetAccountInfoApi & GetTokenAccountBalanceApi>,
    pool: PoolInfo,
    tokens: Record<TokenSymbol, TokenInfo>,
): Promise<Reserves> {
    const { data } = await fetchPoolState(rpc, pool.address);
    const [vault0, vault1] = await Promise.all(
        [data.token0Vault, data.token1Vault].map(async vault =>
            BigInt((await rpc.getTokenAccountBalance(vault, { commitment: 'confirmed' }).send()).value.amount),
        ),
    );
    const reserve0 = vault0! - data.protocolFeesToken0 - data.fundFeesToken0 - data.creatorFeesToken0;
    const reserve1 = vault1! - data.protocolFeesToken1 - data.fundFeesToken1 - data.creatorFeesToken1;
    return data.token0Mint === tokens[pool.base].mint
        ? { base: reserve0, quote: reserve1 }
        : { base: reserve1, quote: reserve0 };
}

/** `swap_base_input` from the owner's associated accounts; `buy` spends quote for base. */
export async function swapInstruction(p: {
    pool: PoolInfo;
    tokens: Record<TokenSymbol, TokenInfo>;
    ammConfig: Address;
    owner: TransactionSigner;
    payer: TransactionSigner;
    side: 'buy' | 'sell';
    amountIn: bigint;
    minimumAmountOut: bigint;
}): Promise<Instruction[]> {
    const [input, output] =
        p.side === 'buy'
            ? [p.tokens[p.pool.quote], p.tokens[p.pool.base]]
            : [p.tokens[p.pool.base], p.tokens[p.pool.quote]];
    const vault = (token: TokenInfo) => (token.mint === p.pool.token0Mint ? p.pool.token0Vault : p.pool.token1Vault);
    const [[inputTokenAccount], [outputTokenAccount]] = await Promise.all([
        findAssociatedTokenPda({ mint: input.mint, owner: p.owner.address, tokenProgram: input.tokenProgram }),
        findAssociatedTokenPda({ mint: output.mint, owner: p.owner.address, tokenProgram: output.tokenProgram }),
    ]);
    return [
        await getCreateAssociatedTokenIdempotentInstructionAsync({
            mint: output.mint,
            owner: p.owner.address,
            payer: p.payer,
            tokenProgram: output.tokenProgram,
        }),
        await getSwapBaseInputInstructionAsync({
            amountIn: p.amountIn,
            ammConfig: p.ammConfig,
            inputTokenAccount,
            inputTokenMint: input.mint,
            inputTokenProgram: input.tokenProgram,
            inputVault: vault(input),
            minimumAmountOut: p.minimumAmountOut,
            observationState: p.pool.observation,
            outputTokenAccount,
            outputTokenMint: output.mint,
            outputTokenProgram: output.tokenProgram,
            outputVault: vault(output),
            payer: p.owner,
            poolState: p.pool.address,
        }),
    ];
}
