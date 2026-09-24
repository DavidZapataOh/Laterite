import { findConfigPda, LATERITE_PROGRAM_ADDRESS } from '@laterite/client';
import { createClient, loadSigner } from '@laterite/devnet';
import { type Address, address, lamports } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';

import {
    type Deployment,
    type DeploymentRecord,
    deploymentFile,
    devnetConfigParams,
    ensureDeployment,
    MARKET_CALENDAR_FILE,
    readDeploymentRecord,
    readMarketCalendar,
    writeDeploymentRecord,
} from '../src';

// The sponsor pays every onboarding's accounts and fees; the services alarm on its balance.
const SPONSOR_MINIMUM = 500_000_000n;
const SPONSOR_FUNDING = 1_000_000_000n;

const client = createClient();
const authority = await loadSigner('devnet-authority');
const file = deploymentFile();
const previous = await readDeploymentRecord(file);

/**
 * The attestor's or sponsor's public key: the recorded one, or on the first run the one given; its secret is held by
 * the service that signs with it, never here. A key other than the recorded one needs `just rotate-key`.
 */
function settingsKey(role: 'attestor' | 'sponsor'): Address {
    const given = process.env[`DEVNET_${role.toUpperCase()}`];
    if (previous && given && given !== previous[role]) {
        throw new Error(`The recorded ${role} is ${previous[role]}, not ${given}: rotate it with just rotate-key`);
    }
    if (previous) return previous[role];
    if (!given) throw new Error(`Give the ${role}'s public key in DEVNET_${role.toUpperCase()} for the first run`);
    return address(given);
}

const [attestor, sponsor] = [settingsKey('attestor'), settingsKey('sponsor')];
const balance = async () => (await client.rpc.getBalance(authority.address).send()).value;
const before = await balance();
const genesisHash = await client.rpc.getGenesisHash().send();
const [config] = await findConfigPda();
const record = (deployment: Deployment): DeploymentRecord => ({
    admin: deployment.config.admin,
    attestor: deployment.config.attestor,
    config,
    genesisHash,
    lookupTable: deployment.lookupTable,
    marketCalendarSet: deployment.marketCalendarSet,
    program: LATERITE_PROGRAM_ADDRESS,
    sponsor: deployment.config.sponsor,
    swapAccounts: { USDC: deployment.swapAccounts[0]!, USDT: deployment.swapAccounts[1]! },
    upgradeAuthority: authority.address,
});

const deployment = await ensureDeployment(client, {
    authority,
    calendar: await readMarketCalendar(MARKET_CALENDAR_FILE),
    params: devnetConfigParams({ attestor, genesisHash, sponsor }),
    record: async progress => await writeDeploymentRecord(file, record(progress)),
    recorded: previous ?? undefined,
});
await writeDeploymentRecord(file, record(deployment));

const sponsorBalance = (await client.rpc.getBalance(sponsor).send()).value;
if (sponsorBalance < SPONSOR_MINIMUM) {
    await client.send(authority, [
        getTransferSolInstruction({
            amount: lamports(SPONSOR_FUNDING - sponsorBalance),
            destination: sponsor,
            source: authority,
        }),
    ]);
}

const spent = Number(before - (await balance())) / 1e9;
console.log(`✓ Laterite configured: ${client.sentCount()} transactions sent, ${spent} SOL spent by the authority`);
console.log(`  genesis hash  ${genesisHash} (stored in the config at initialize)`);
console.log(`  attestor      ${attestor}`);
console.log(`  sponsor       ${sponsor}`);
console.log(`  lookup table  ${deployment.lookupTable}`);
console.log(`  calendar      ${deployment.marketCalendarSet ?? 'loaded before this record'}`);
console.log(`  record        ${file.pathname}`);
