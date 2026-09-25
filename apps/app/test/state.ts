import { Engine, type UserConfig, type UserState, UserStatus } from '@laterite/client';
import { type Address, getAddressDecoder } from '@solana/kit';

import { testConfig } from '../e2e/support/config';

export const config = testConfig();
const key = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
export const wallet = key(1);
/** The wallet's Subscriptions authority over a token. */
export const authority = key(2);
/** Another program's approval of the wallet's account. */
export const other = key(3);

type Account = {
    amount: bigint;
    delegate?: Address | 'authority' | 'other';
    delegatedAmount?: bigint;
    frozen?: boolean;
};

/** A wallet's state as `fetchUserState` reads it: its payment-token accounts (`null` when missing) and `UserConfig`. */
export function userState(tokens: (Account | null)[], userConfig: UserConfig | null = null, now = 0n): UserState {
    return {
        assets: [],
        now,
        plans: [],
        tokens: tokens.map((account, paymentToken) => ({
            account: wallet,
            accountState: account && {
                amount: account.amount,
                delegate: account.delegate === 'authority' ? authority : account.delegate === 'other' ? other : null,
                delegatedAmount: account.delegatedAmount ?? 0n,
                frozen: account.frozen ?? false,
            },
            authority,
            authorityState: null,
            mint: config.paymentTokens[paymentToken]!.mint,
            paymentToken,
            tokenProgram: config.paymentTokens[paymentToken]!.tokenProgram,
        })),
        userConfig,
        userConfigAddress: wallet,
    };
}

/** An account that enrolled at `enrolledAt` and exited, with its counters. */
export function exited(enrolledAt: bigint, week: number, weekSpent: bigint): UserConfig {
    return {
        asset: 0,
        attestableFrom: enrolledAt,
        bump: 255,
        changeMultiplier: 0,
        cushions: [0n, 0n],
        discriminator: new Uint8Array(8),
        engine: Engine.Daily,
        engineAmount: 0n,
        engineRanAt: 0n,
        enrolledAt,
        goalAmount: 0n,
        goalLabel: new Uint8Array(32),
        incomeRule: false,
        lastSweepDay: [0, 0],
        paymentTokens: 0,
        pending: 0n,
        status: UserStatus.Exited,
        tier: 0,
        user: wallet,
        week,
        weekSpent,
    };
}
