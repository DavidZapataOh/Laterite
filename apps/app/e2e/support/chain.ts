import {
    Engine,
    findConfigPda,
    findPlanAddress,
    findSwapAuthorityPda,
    findUserConfigPda,
    findVaultPda,
    getConfigEncoder,
    getUserConfigEncoder,
    LATERITE_PROGRAM_ADDRESS,
    TIERS,
    UserStatus,
} from '@laterite/client';
import { addresses } from '@laterite/devnet/addresses';
import { AccountDiscriminator, getPlanEncoder, SUBSCRIPTIONS_PROGRAM_ADDRESS } from '@solana/subscriptions';
import {
    AccountState,
    findAssociatedTokenPda,
    getMintEncoder,
    getTokenEncoder,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { type Address, getBase64Decoder, type ReadonlyUint8Array } from '@solana/kit';
import type { Config } from '@laterite/client';

import { testConfig } from './config';
import { ENROLLED_AT, faucet, testKey, users } from './keys';

/** Another program the delegated wallet's USDC account approves. */
export const otherApp = testKey('other-app');

/** An account the test validator loads at genesis (`--account-dir`), in the Solana CLI's JSON form. */
export type GenesisAccount = {
    account: {
        data: [string, 'base64'];
        executable: false;
        lamports: number;
        owner: Address;
        rentEpoch: 0;
        space: number;
    };
    pubkey: Address;
};

const account = (pubkey: Address, owner: Address, data: ReadonlyUint8Array, lamports = 10_000_000): GenesisAccount => ({
    account: {
        data: [getBase64Decoder().decode(data), 'base64'],
        executable: false,
        lamports,
        owner,
        rentEpoch: 0,
        space: data.length,
    },
    pubkey,
});

const DOLLAR = 1_000_000n;

async function userConfig(user: Address, tier: number, status: UserStatus) {
    const [address, bump] = await findUserConfigPda({ user });
    const data = getUserConfigEncoder().encode({
        asset: 0,
        attestableFrom: ENROLLED_AT,
        bump,
        changeMultiplier: 0,
        cushions: [20_000_000n, 20_000_000n],
        engine: Engine.Daily,
        engineAmount: 1_000_000n,
        engineRanAt: 0n,
        enrolledAt: ENROLLED_AT,
        goalAmount: 0n,
        goalLabel: new Uint8Array(32),
        incomeRule: true,
        lastSweepDay: [0, 0],
        paymentTokens: 1,
        pending: 0n,
        status,
        tier,
        user,
        week: 0,
        weekSpent: 0n,
    });
    return account(address, LATERITE_PROGRAM_ADDRESS, data, 1_483_360);
}

/** The devnet USDC and USDT stand-ins at their devnet addresses, with the tests' faucet as mint authority. */
const stables = (['USDC', 'USDT'] as const).map(symbol =>
    account(
        addresses.tokens[symbol].mint,
        TOKEN_PROGRAM_ADDRESS,
        getMintEncoder().encode({
            decimals: 6,
            freezeAuthority: null,
            isInitialized: true,
            mintAuthority: faucet.address,
            supply: 1_000_000n * DOLLAR,
        }),
    ),
);

/** `owner`'s associated account in a devnet stablecoin, holding `amount`, approving `delegate` when given. */
async function tokenAccount(owner: Address, symbol: 'USDC' | 'USDT', amount: bigint, delegate?: Address) {
    const { mint } = addresses.tokens[symbol];
    const [address] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const data = getTokenEncoder().encode({
        amount,
        closeAuthority: null,
        delegate: delegate ?? null,
        delegatedAmount: delegate ? 40n * DOLLAR : 0n,
        isNative: null,
        mint,
        owner,
        state: AccountState.Initialized,
    });
    return account(address, TOKEN_PROGRAM_ADDRESS, data, 2_039_280);
}

/** Laterite's four plans ($10 and $25 a week in USDC and USDT) as Subscriptions holds them, owned by the vault. */
async function plans(config: Config) {
    const [[vault], [swapAuthority]] = await Promise.all([findVaultPda(), findSwapAuthorityPda()]);
    const none = '11111111111111111111111111111111' as Address;
    return Promise.all(
        [0, 1].flatMap(paymentToken =>
            [0, 1].map(async tier => {
                const data = getPlanEncoder().encode({
                    bump: 255,
                    data: {
                        destinations: [swapAuthority, none, none, none],
                        endTs: 0n,
                        metadataUri: '',
                        mint: config.paymentTokens[paymentToken]!.mint,
                        planId: BigInt(paymentToken * 2 + tier + 1),
                        pullers: [none, none, none, none],
                        terms: { amount: TIERS[tier as 0 | 1], createdAt: ENROLLED_AT, periodHours: 168n },
                    },
                    discriminator: AccountDiscriminator.Plan,
                    owner: vault,
                    status: 0,
                });
                return account(await findPlanAddress(paymentToken, tier), SUBSCRIPTIONS_PROGRAM_ADDRESS, data);
            }),
        ),
    );
}

/**
 * Every account the tests' chain starts with: Laterite's `Config` (`changes` applied) and plans, the stand-in
 * stablecoins with the tests' faucet as mint authority, the faucet's SOL, and each genesis user's accounts.
 */
export async function genesis(changes: Partial<Config> = {}): Promise<GenesisAccount[]> {
    const config = testConfig(changes);
    const [configAddress] = await findConfigPda();
    return [
        account(configAddress, LATERITE_PROGRAM_ADDRESS, getConfigEncoder().encode(config), 5_034_280),
        ...(await plans(config)),
        ...stables,
        account(faucet.address, '11111111111111111111111111111111' as Address, new Uint8Array(), 100_000_000_000),
        await userConfig(users.active.address, 1, UserStatus.Active),
        await userConfig(users.paused.address, 0, UserStatus.Paused),
        await userConfig(users.exited.address, 1, UserStatus.Exited),
        await tokenAccount(users.exited.address, 'USDC', 60n * DOLLAR),
        await tokenAccount(users.holder.address, 'USDC', 250n * DOLLAR),
        await tokenAccount(users.holder.address, 'USDT', 120n * DOLLAR),
        await tokenAccount(users.delegated.address, 'USDC', 80n * DOLLAR, otherApp.address),
    ];
}
