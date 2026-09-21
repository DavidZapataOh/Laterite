import {
    AccountRole,
    address,
    type Address,
    fetchEncodedAccount,
    type GetAccountInfoApi,
    lamports,
    type Rpc,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
    fetchMaybeMint as fetchMaybeStableMint,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
    fetchMaybeMint,
    fetchMint,
    findAssociatedTokenPda,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';

import type { DevnetAddresses, PoolInfo, TokenInfo } from './addresses';
import {
    DECIMALS,
    MAINNET_MINTS,
    POOLS,
    poolName,
    type PoolName,
    PYTH_FEEDS,
    type Stable,
    STABLES,
    type TokenSymbol,
    type XStock,
    XSTOCKS,
} from './assets';
import type { Client } from './client';
import { ammConfigAddress, orderMints, POOL_FEES, poolAddress, supportMintAddress } from './cpmm';
import {
    fetchMaybeAmmConfig,
    fetchMaybePoolState,
    fetchPoolState,
    getCreateAmmConfigInstruction,
    getCreateSupportMintAssociatedInstruction,
    getInitializeInstructionAsync,
    RAYDIUM_CP_SWAP_PROGRAM_ADDRESS,
} from './generated';
import { loadSigner } from './keys';
import {
    createStableMintInstructions,
    createXStockMintInstructions,
    mintToInstructions,
    syncMultiplierInstruction,
    tokenBalance,
} from './mints';

export type SetupKeys = Awaited<ReturnType<typeof loadSetupKeys>>;

export type SetupContext = {
    client: Client;
    mainnetRpc: Rpc<GetAccountInfoApi>;
    keys: SetupKeys;
};

/** Every devnet key the setup signs with. */
export async function loadSetupKeys() {
    const [issuer, faucet, treasury, USDC, USDT, SPYx, QQQx] = await Promise.all([
        loadSigner('devnet-issuer'),
        loadSigner('devnet-faucet'),
        loadSigner('devnet-treasury'),
        loadSigner('devnet-usdc'),
        loadSigner('devnet-usdt'),
        loadSigner('devnet-spyx'),
        loadSigner('devnet-qqqx'),
    ]);
    return { faucet, issuer, mints: { QQQx, SPYx, USDC, USDT }, treasury };
}

/** Creates any missing stand-in mint and keeps the xStock multipliers in step with mainnet. */
export async function ensureMints({ client, mainnetRpc, keys }: SetupContext): Promise<void> {
    for (const symbol of STABLES) {
        const mint = keys.mints[symbol];
        if ((await fetchMaybeStableMint(client.rpc, mint.address)).exists) continue;
        await client.send(
            keys.issuer,
            await createStableMintInstructions(client.rpc, {
                faucet: keys.faucet.address,
                freezeAuthority: keys.issuer.address,
                mint,
                payer: keys.issuer,
            }),
        );
    }
    for (const symbol of XSTOCKS) {
        const mint = keys.mints[symbol];
        const { data: source } = await fetchMint(mainnetRpc, MAINNET_MINTS[symbol]);
        const existing = await fetchMaybeMint(client.rpc, mint.address);
        if (!existing.exists) {
            await client.send(
                keys.issuer,
                await createXStockMintInstructions(client.rpc, source, {
                    issuer: keys.issuer,
                    mint,
                    payer: keys.issuer,
                }),
            );
            continue;
        }
        const sync = syncMultiplierInstruction(source, existing.data, mint.address, keys.issuer);
        if (sync) await client.send(keys.issuer, [sync]);
    }
}

const LIQUIDITY_USD = 100_000;
const RESERVE_USD = 20_000;
const MIN_ISSUER_LAMPORTS = 1_000_000_000n;
const MIN_TREASURY_LAMPORTS = 500_000_000n;
const TREASURY_TOP_UP = lamports(1_000_000_000n);
const WRAPPED_SOL = address('So11111111111111111111111111111111111111112');

const exists = async (context: SetupContext, account: Address) =>
    (await fetchEncodedAccount(context.client.rpc, account)).exists;

function tokenInfo(keys: SetupKeys, supportMints: Record<XStock, Address>): Record<TokenSymbol, TokenInfo> {
    const stable = (symbol: Stable): TokenInfo => ({
        decimals: DECIMALS[symbol],
        mint: keys.mints[symbol].address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        ...(symbol === 'USDT' ? { pyth: PYTH_FEEDS.USDT } : {}),
    });
    const xStock = (symbol: XStock): TokenInfo => ({
        decimals: DECIMALS[symbol],
        mint: keys.mints[symbol].address,
        pyth: PYTH_FEEDS[symbol],
        supportMint: supportMints[symbol],
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    return { QQQx: xStock('QQQx'), SPYx: xStock('SPYx'), USDC: stable('USDC'), USDT: stable('USDT') };
}

async function ensureSol(context: SetupContext): Promise<void> {
    const { client, keys } = context;
    const issuer = (await client.rpc.getBalance(keys.issuer.address).send()).value;
    if (issuer < MIN_ISSUER_LAMPORTS) {
        throw new Error(`Fund the devnet issuer ${keys.issuer.address} with at least 1 SOL (faucet.solana.com)`);
    }
    const treasury = (await client.rpc.getBalance(keys.treasury.address).send()).value;
    if (treasury < MIN_TREASURY_LAMPORTS) {
        await client.send(keys.issuer, [
            getTransferSolInstruction({
                amount: TREASURY_TOP_UP,
                destination: keys.treasury.address,
                source: keys.issuer,
            }),
        ]);
    }
}

async function ensureCpmmConfig(context: SetupContext): Promise<Address> {
    const { client, keys } = context;
    const ammConfig = await ammConfigAddress();
    if ((await fetchMaybeAmmConfig(client.rpc, ammConfig)).exists) return ammConfig;
    await client.send(keys.issuer, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({
            mint: WRAPPED_SOL,
            owner: keys.issuer.address,
            payer: keys.issuer,
        }),
        getCreateAmmConfigInstruction({
            ammConfig,
            createPoolFee: 0n,
            creatorFeeRate: 0n,
            fundFeeRate: POOL_FEES.fundFeeRate,
            index: 0,
            owner: keys.issuer,
            protocolFeeRate: POOL_FEES.protocolFeeRate,
            tradeFeeRate: POOL_FEES.tradeFeeRate,
        }),
    ]);
    return ammConfig;
}

async function ensureWhitelist(context: SetupContext): Promise<Record<XStock, Address>> {
    const { client, keys } = context;
    const entries = {
        QQQx: await supportMintAddress(keys.mints.QQQx.address),
        SPYx: await supportMintAddress(keys.mints.SPYx.address),
    };
    const missing: XStock[] = [];
    for (const symbol of ['SPYx', 'QQQx'] as const) {
        if (!(await exists(context, entries[symbol]))) missing.push(symbol);
    }
    if (missing.length > 0) {
        await client.send(
            keys.issuer,
            missing.map(symbol =>
                getCreateSupportMintAssociatedInstruction({
                    owner: keys.issuer,
                    supportMintAssociated: entries[symbol],
                    tokenMint: keys.mints[symbol].address,
                }),
            ),
        );
    }
    return entries;
}

async function ensureInventory(
    context: SetupContext,
    tokens: Record<TokenSymbol, TokenInfo>,
    missingPools: { base: XStock; quote: Stable }[],
    targets: Record<PoolName, number>,
): Promise<void> {
    const { client, keys } = context;
    const usd = { QQQx: 0, SPYx: 0, USDC: 0, USDT: 0 } as Record<TokenSymbol, number>;
    const baseUnits = { QQQx: 0, SPYx: 0 } as Record<XStock, number>;
    for (const { base, quote } of POOLS) {
        const amount = RESERVE_USD + (missingPools.some(p => p.base === base && p.quote === quote) ? LIQUIDITY_USD : 0);
        usd[quote] += amount;
        baseUnits[base] += amount / targets[poolName(base, quote)];
    }
    for (const symbol of ['USDC', 'USDT', 'SPYx', 'QQQx'] as const) {
        const token = tokens[symbol];
        const whole = symbol === 'SPYx' || symbol === 'QQQx' ? baseUnits[symbol] : usd[symbol];
        const target = BigInt(Math.ceil(whole * 10 ** token.decimals));
        const balance = await tokenBalance(client.rpc, keys.treasury.address, token.mint, token.tokenProgram);
        if (balance * 2n >= target) continue;
        await client.send(
            keys.issuer,
            await mintToInstructions({
                amount: target - balance,
                authority: symbol === 'USDC' || symbol === 'USDT' ? keys.faucet : keys.issuer,
                decimals: token.decimals,
                mint: token.mint,
                owner: keys.treasury.address,
                payer: keys.issuer,
                tokenProgram: token.tokenProgram,
            }),
        );
    }
}

async function ensurePool(
    context: SetupContext,
    tokens: Record<TokenSymbol, TokenInfo>,
    ammConfig: Address,
    base: XStock,
    quote: Stable,
    target: number,
): Promise<PoolInfo> {
    const { client, keys } = context;
    const [token0Mint, token1Mint] = orderMints(tokens[base].mint, tokens[quote].mint);
    const address = await poolAddress(ammConfig, token0Mint, token1Mint);
    if (!(await fetchMaybePoolState(client.rpc, address)).exists) {
        const baseAmount = BigInt(Math.round((LIQUIDITY_USD / target) * 10 ** tokens[base].decimals));
        const quoteAmount = BigInt(LIQUIDITY_USD) * 10n ** BigInt(tokens[quote].decimals);
        const baseIs0 = token0Mint === tokens[base].mint;
        const account = async (token: TokenInfo) =>
            (
                await findAssociatedTokenPda({
                    mint: token.mint,
                    owner: keys.treasury.address,
                    tokenProgram: token.tokenProgram,
                })
            )[0];
        const [token0, token1] = baseIs0 ? [tokens[base], tokens[quote]] : [tokens[quote], tokens[base]];
        const initialize = await getInitializeInstructionAsync({
            ammConfig,
            creator: keys.treasury,
            creatorToken0: await account(token0),
            creatorToken1: await account(token1),
            initAmount0: baseIs0 ? baseAmount : quoteAmount,
            initAmount1: baseIs0 ? quoteAmount : baseAmount,
            openTime: 0n,
            poolState: address,
            token0Mint,
            token0Program: token0.tokenProgram,
            token1Mint,
            token1Program: token1.tokenProgram,
        });
        await client.send(keys.treasury, [
            {
                ...initialize,
                accounts: [...initialize.accounts, { address: tokens[base].supportMint!, role: AccountRole.READONLY }],
            },
        ]);
    }
    const { data } = await fetchPoolState(client.rpc, address);
    return {
        address,
        base,
        lpMint: data.lpMint,
        observation: data.observationKey,
        quote,
        token0Mint: data.token0Mint,
        token0Vault: data.token0Vault,
        token1Mint: data.token1Mint,
        token1Vault: data.token1Vault,
    };
}

/** Creates or verifies every devnet asset and returns their addresses; a rerun sends nothing. */
export async function ensureAssets(context: SetupContext, targets: Record<PoolName, number>): Promise<DevnetAddresses> {
    await ensureSol(context);
    await ensureMints(context);
    const ammConfig = await ensureCpmmConfig(context);
    const tokens = tokenInfo(context.keys, await ensureWhitelist(context));

    const missingPools = [];
    for (const pool of POOLS) {
        const [token0, token1] = orderMints(tokens[pool.base].mint, tokens[pool.quote].mint);
        if (!(await exists(context, await poolAddress(ammConfig, token0, token1)))) missingPools.push(pool);
    }
    await ensureInventory(context, tokens, missingPools, targets);

    const pools = {} as Record<PoolName, PoolInfo>;
    for (const { base, quote } of POOLS) {
        pools[poolName(base, quote)] = await ensurePool(
            context,
            tokens,
            ammConfig,
            base,
            quote,
            targets[poolName(base, quote)],
        );
    }
    return {
        cpmm: { ammConfig, program: RAYDIUM_CP_SWAP_PROGRAM_ADDRESS },
        issuer: context.keys.issuer.address,
        pools,
        tokens,
        treasury: context.keys.treasury.address,
    };
}
