import { fetchConfig, findConfigPda, getProposeAdminInstruction } from '@laterite/client';
import { createClient, loadSigner } from '@laterite/devnet';
import { address } from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';

const client = createClient();
const admin = await loadSigner('devnet-authority');
const newAdmin = address(process.argv[2] ?? '');
const { data: config } = await fetchConfig(client.rpc, (await findConfigPda())[0]);
if (config.admin !== admin.address) throw new Error(`The admin is ${config.admin}, not ${admin.address}`);
const signature = await client.send(admin, [getProposeAdminInstruction({ admin, newAdmin })]);
console.log(
    newAdmin === SYSTEM_PROGRAM_ADDRESS
        ? `✓ Cancelled the pending handover in ${signature}`
        : `✓ Proposed ${newAdmin} as admin in ${signature}; it takes over when it signs accept_admin`,
);
