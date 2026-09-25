import type { Address, GetAccountInfoApi, GetMultipleAccountsApi, Rpc } from '@solana/kit';
import {
    type Config,
    fetchConfig,
    fetchMaybeUserConfig,
    fetchUserState,
    findConfigPda,
    findUserConfigPda,
    LATERITE_PROGRAM_ADDRESS,
    type UserConfig,
    type UserState,
    UserStatus,
} from '@laterite/client';

/** What Laterite knows of a wallet on-chain. */
export type AccountState =
    { kind: 'new' } | { kind: 'exited'; config: UserConfig } | { kind: 'enrolled'; config: UserConfig };

/** Reads `user`'s `UserConfig`: none yet, exited (the account stays), or enrolled (active or paused). */
export async function readAccount(
    rpc: Rpc<GetAccountInfoApi>,
    user: Address,
    abortSignal?: AbortSignal,
): Promise<AccountState> {
    const [address] = await findUserConfigPda({ user });
    const account = await fetchMaybeUserConfig(rpc, address, { abortSignal, commitment: 'confirmed' });
    if (!account.exists) return { kind: 'new' };
    if (account.programAddress !== LATERITE_PROGRAM_ADDRESS) throw new Error(`${address} is not owned by Laterite`);
    return account.data.status === UserStatus.Exited
        ? { kind: 'exited', config: account.data }
        : { kind: 'enrolled', config: account.data };
}

/** What onboarding reads: Laterite's `Config`, then everything the onboarding transaction would read for `user`. */
export type OnboardingData = { config: Config; state: UserState };

export async function readOnboarding(
    rpc: Rpc<GetAccountInfoApi & GetMultipleAccountsApi>,
    user: Address,
    abortSignal?: AbortSignal,
): Promise<OnboardingData> {
    const [address] = await findConfigPda();
    const { data: config } = await fetchConfig(rpc, address, { abortSignal, commitment: 'confirmed' });
    return { config, state: await fetchUserState(rpc, config, user) };
}
