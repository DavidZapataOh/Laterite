import { fetchConfig, findConfigPda } from '@laterite/client';
import { createClient, loadSigner } from '@laterite/devnet';
import { address } from '@solana/kit';

import {
    AdminHandedOverError,
    deploymentFile,
    readDeploymentRecord,
    rotateSettingsKey,
    type SettingsKey,
    writeDeploymentRecord,
} from '../src';

const [role, key] = [process.argv[2] as SettingsKey, address(process.argv[3] ?? '')];
if (role !== 'attestor' && role !== 'sponsor') throw new Error('Rotate the attestor or the sponsor');
const client = createClient();
const file = deploymentFile();
const record = await readDeploymentRecord(file);
if (!record) throw new Error(`No deployment recorded in ${file.pathname}: run the deploy recipe first`);
const { data: config } = await fetchConfig(client.rpc, (await findConfigPda())[0]);
if (config[role] !== key) {
    try {
        const signature = await rotateSettingsKey(client, await loadSigner('devnet-authority'), config, role, key);
        console.log(`✓ The config's ${role} is ${key} (update_config ${signature})`);
    } catch (error) {
        if (!(error instanceof AdminHandedOverError)) throw error;
        console.error(error.message);
        process.exit(1);
    }
}
await writeDeploymentRecord(file, { ...record, [role]: key });
