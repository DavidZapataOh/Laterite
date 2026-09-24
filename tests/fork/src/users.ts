import {
    type Config,
    createSponsoredTransactionMessage,
    DAY_SECONDS,
    Engine,
    type EnrollParamsArgs,
    fetchConfig,
    fetchUserConfig,
    findConfigPda,
    findUserConfigPda,
    getOnboardingInstructions,
    getUserConfigEncoder,
    WEEK_SECONDS,
} from '@laterite/client';
import {
    type Address,
    getBase16Decoder,
    generateKeyPairSigner,
    type KeyPairSigner,
    type MicroLamports,
} from '@solana/kit';
import { fetchAddressLookupTable } from '@solana-program/address-lookup-table';

import type { ForkContext, ForkKeys } from './deployment';
import { cheatcodes, DOLLAR, fundToken, type Landed, rpc, sendMessage } from './fork';

export async function fetchForkConfig(): Promise<Config> {
    return (await fetchConfig(rpc, (await findConfigPda())[0])).data;
}

/** A new user's choices: one payment token, one asset, a daily engine buying `engineAmount`, the $10 tier. */
export const enrollParams = (input: Partial<EnrollParamsArgs> & { asset: number; paymentTokens: number }) => ({
    changeMultiplier: 0,
    cushions: [20n * DOLLAR, 20n * DOLLAR],
    engine: Engine.Daily,
    engineAmount: 5n * DOLLAR,
    goalAmount: 1_000n * DOLLAR,
    goalLabel: new Uint8Array(32),
    incomeRule: false,
    tier: 0,
    ...input,
});

/**
 * A wallet holding $100 of the payment token on mainnet, enrolled through the sponsored onboarding transaction
 * (version 0, the deployment's lookup table) that the app sends.
 */
export async function enroll(
    fork: { deployment: ForkContext['deployment']; keys: ForkKeys },
    params: EnrollParamsArgs,
): Promise<{ landed: Landed; user: KeyPairSigner }> {
    const config = await fetchForkConfig();
    const user = await generateKeyPairSigner();
    for (const [index, token] of config.paymentTokens.entries()) {
        if (params.paymentTokens & (1 << index))
            await fundToken(user.address, token.mint, 100n * DOLLAR, token.tokenProgram);
    }
    const { instructions } = await getOnboardingInstructions({ config, params, rpc, sponsor: fork.keys.sponsor, user });
    const { lookupTable } = fork.deployment;
    const { data: table } = await fetchAddressLookupTable(rpc, lookupTable);
    const landed = await sendMessage(
        createSponsoredTransactionMessage({
            computeUnitPrice: 1_000n as MicroLamports,
            instructions,
            lookupTable: { [lookupTable]: table.addresses },
            sponsor: fork.keys.sponsor,
        }),
    );
    return { landed, user };
}

/**
 * Moves a user's enrollment eight days back, past the $5 trial week, so a sweep pulls its whole tier. A state override
 * the suite uses only to measure tier-sized sweeps: the fork's clock follows wall time and cannot go back to enroll a
 * user in the past, while price updates are only fresh at wall time.
 */
export async function backdateEnrollment(user: Address) {
    const [address] = await findUserConfigPda({ user });
    const { data } = await fetchUserConfig(rpc, address);
    const enrolledAt = data.enrolledAt - WEEK_SECONDS - DAY_SECONDS;
    const bytes = getUserConfigEncoder().encode({ ...data, enrolledAt });
    await cheatcodes.setAccount(address, { data: getBase16Decoder().decode(bytes) }).send();
}
