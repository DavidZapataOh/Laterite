import { LATERITE_PROGRAM_ADDRESS, TIERS } from '@laterite/client';
import {
    type Deployment,
    ensureDeployment,
    JUPITER_ROUTE_MINTS,
    mainnetConfigParams,
    MARKET_CALENDAR_FILE,
    readMarketCalendar,
} from '@laterite/deployment';
import { type Address, createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from '@solana/kit';
import { inject } from 'vitest';

import { airdrop, cheatcodes, cluster, rpc } from './fork';

/** The fork deployment's keys as private key bytes: generated for each run, never written anywhere. */
export type ForkKeySeeds = Record<'attestor' | 'authority' | 'sponsor', number[]>;

/** What the global setup leaves for the tests: the fork's keys and deployment. */
export type ForkContext = { deployment: { lookupTable: Address; swapAccounts: Address[] }; seeds: ForkKeySeeds };

declare module 'vitest' {
    export interface ProvidedContext {
        fork: ForkContext;
    }
}

/** A fresh set of fork-only keys: the upgrade authority (the admin, and the crank), the attestor and the sponsor. */
export const generateForkKeySeeds = (): ForkKeySeeds => ({
    attestor: [...crypto.getRandomValues(new Uint8Array(32))],
    authority: [...crypto.getRandomValues(new Uint8Array(32))],
    sponsor: [...crypto.getRandomValues(new Uint8Array(32))],
});

export type ForkKeys = Record<keyof ForkKeySeeds, KeyPairSigner>;

export async function forkKeys(seeds: ForkKeySeeds): Promise<ForkKeys> {
    const signer = (seed: number[]) => createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(seed));
    const [attestor, authority, sponsor] = await Promise.all(
        [seeds.attestor, seeds.authority, seeds.sponsor].map(signer),
    );
    return { attestor: attestor!, authority: authority!, sponsor: sponsor! };
}

/** The mainnet configuration with the fork's keys and the beta caps devnet uses. */
export async function forkConfigParams(keys: ForkKeys) {
    return mainnetConfigParams({
        genesisHash: await rpc.getGenesisHash().send(),
        settings: {
            attestor: keys.attestor.address,
            maxUsers: 1_000,
            sponsor: keys.sponsor.address,
            userWeeklyCap: TIERS[1],
        },
    });
}

/**
 * Deploys Laterite on the fork as a cluster's deployment runbook does: the upgrade authority initializes the config
 * with Jupiter as router, the mainnet tables and the genesis hash the fork reports, then the plans, the swap
 * authority's accounts (the payment tokens' and Jupiter's route mints), the NYSE calendar and the onboarding lookup
 * table. Surfpool installs the program without an upgrade authority, so the fork's one is set by cheatcode first.
 */
export async function deployFork(keys: ForkKeys): Promise<Deployment> {
    await Promise.all([airdrop(keys.authority.address, 100n), airdrop(keys.sponsor.address, 10n)]);
    await cheatcodes.setProgramAuthority(LATERITE_PROGRAM_ADDRESS, keys.authority.address).send();
    return await ensureDeployment(cluster, {
        authority: keys.authority,
        calendar: await readMarketCalendar(MARKET_CALENDAR_FILE),
        params: await forkConfigParams(keys),
        routeMints: JUPITER_ROUTE_MINTS,
    });
}

/** The keys and deployment the global setup made for this run. */
export async function forkContext() {
    const { deployment, seeds } = inject('fork');
    return { deployment, keys: await forkKeys(seeds), seeds };
}
