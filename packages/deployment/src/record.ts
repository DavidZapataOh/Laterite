import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import type { Address, Signature } from '@solana/kit';

/**
 * A cluster's deployment as the deploy runbook leaves it, public addresses only; it is written as the deployment
 * progresses, so the lookup table's address is there before the table is created. To create another table, delete
 * `lookupTable` and run the deploy again.
 */
export type DeploymentRecord = {
    admin: Address;
    attestor: Address;
    config: Address;
    genesisHash: string;
    lookupTable?: Address;
    /** The transaction whose `MarketCalendarSet` loaded the calendar the config holds. */
    marketCalendarSet?: Signature;
    program: Address;
    sponsor: Address;
    swapAccounts: { USDC: Address; USDT: Address };
    upgradeAuthority: Address;
};

/**
 * Where a devnet target's deployment is recorded: `DEVNET_DEPLOYMENT_FILE` (the recipes point the local devnet at
 * `test-ledger/`), else the committed devnet record.
 */
export const deploymentFile = () =>
    process.env.DEVNET_DEPLOYMENT_FILE
        ? pathToFileURL(process.env.DEVNET_DEPLOYMENT_FILE)
        : new URL('../../devnet/deployment.json', import.meta.url);

/** The recorded deployment, or `null` before the first run. */
export async function readDeploymentRecord(file: URL): Promise<DeploymentRecord | null> {
    try {
        return JSON.parse(await readFile(file, 'utf8')) as DeploymentRecord;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

export async function writeDeploymentRecord(file: URL, record: DeploymentRecord): Promise<void> {
    await writeFile(file, `${JSON.stringify(record, null, 4)}\n`);
}
