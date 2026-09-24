import { readFileSync } from 'node:fs';

import { createClient } from '@laterite/devnet';

import { deploymentFile, readDeploymentRecord } from '../../src';

export const client = createClient();

const record = await readDeploymentRecord(deploymentFile());
if (!record?.lookupTable) {
    throw new Error(`No complete deployment recorded in ${deploymentFile().pathname}: run the deploy recipe first`);
}
/** The deployment the deploy recipe recorded for this cluster. */
export const deployment = { ...record, lookupTable: record.lookupTable };

const root = new URL('../../../../', import.meta.url);
export const read = (path: string) => new Uint8Array(readFileSync(new URL(path, root)));
