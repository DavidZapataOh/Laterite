import { type Address, getProgramDerivedAddress, getUtf8Encoder, type ProgramDerivedAddress } from '@solana/kit';
import { findPlanPda, findSubscriptionAuthorityPda, findSubscriptionDelegationPda } from '@solana/subscriptions';

import { PLAN_IDS_PER_TOKEN } from './constants';
import { LATERITE_PROGRAM_ADDRESS, SWAP_SEED, VAULT_SEED } from './generated';

// The program's own addresses are fixed, so each is derived once per process.
const derived = new Map<string, Promise<ProgramDerivedAddress>>();
function once(key: string, derive: () => Promise<ProgramDerivedAddress>) {
    let address = derived.get(key);
    if (!address) derived.set(key, (address = derive()));
    return address;
}

/** The vault authority: every plan's owner, which signs only the pulls. */
export const findVaultPda = () =>
    once('vault', () => getProgramDerivedAddress({ programAddress: LATERITE_PROGRAM_ADDRESS, seeds: [VAULT_SEED] }));

/** The swap authority: every plan's only destination and the only signer of a sweep's route. */
export const findSwapAuthorityPda = () =>
    once('swap', () => getProgramDerivedAddress({ programAddress: LATERITE_PROGRAM_ADDRESS, seeds: [SWAP_SEED] }));

/** The authority of the program's self-CPI events. */
export const findEventAuthorityPda = () =>
    once('event', () =>
        getProgramDerivedAddress({
            programAddress: LATERITE_PROGRAM_ADDRESS,
            seeds: [getUtf8Encoder().encode('__event_authority')],
        }),
    );

/** Subscriptions `plan_id` of a payment token's tier: 1–4. */
export const planId = (paymentToken: number, tier: number) => BigInt(paymentToken * PLAN_IDS_PER_TOKEN + tier + 1);

/** The vault's plan for a payment token's tier. */
export async function findPlanAddress(paymentToken: number, tier: number): Promise<Address> {
    const id = planId(paymentToken, tier);
    const [plan] = await once(`plan ${id}`, async () => findPlanPda({ owner: (await findVaultPda())[0], planId: id }));
    return plan;
}

/** `user`'s subscription to the plan for a payment token's tier. */
export async function findSubscriptionAddress(user: Address, paymentToken: number, tier: number): Promise<Address> {
    const planPda = await findPlanAddress(paymentToken, tier);
    const [subscription] = await findSubscriptionDelegationPda({ planPda, subscriber: user });
    return subscription;
}

/** `user`'s Subscriptions authority over their account in `mint`. */
export async function findSubscriptionAuthorityAddress(user: Address, mint: Address): Promise<Address> {
    const [authority] = await findSubscriptionAuthorityPda({ tokenMint: mint, user });
    return authority;
}

/** The enabled payment tokens of a bitmask, in table order. */
export function enabledPaymentTokens(paymentTokens: number): number[] {
    return [0, 1].filter(token => (paymentTokens & (1 << token)) !== 0);
}
