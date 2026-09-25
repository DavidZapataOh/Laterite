import type { Address, GetAccountInfoApi, Rpc } from '@solana/kit';
import {
    fetchMaybeUserConfig,
    findUserConfigPda,
    LATERITE_PROGRAM_ADDRESS,
    type UserConfig,
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
