import type { Address } from '@solana/kit';

import data from '../deployment.json' with { type: 'json' };

/** Laterite's devnet deployment as `just devnet-deploy` recorded it: public addresses only. */
export type DevnetDeployment = {
    config: Address;
    /** The onboarding lookup table (ADR-003), frozen at creation. */
    lookupTable: Address;
    program: Address;
    sponsor: Address;
};

/** Laterite's devnet deployment, from the committed record. */
export const deployment: DevnetDeployment = {
    config: data.config as Address,
    lookupTable: data.lookupTable as Address,
    program: data.program as Address,
    sponsor: data.sponsor as Address,
};
