import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { fileURLToPath } from 'node:url';

import { type GenesisAccount, programs } from './chain';

/** The validator's RPC port (its WebSocket on the next one); its other ports follow it. */
export const RPC_PORT = Number(process.env.VALIDATOR_RPC_PORT ?? 48_899);

/** A second chain whose `Config` has the kill switch set, for the closed state. */
export const CLOSED_RPC_PORT = RPC_PORT + 1_000;

/**
 * Starts a new chain on Agave's test validator on `port` running Laterite and Subscriptions and holding `accounts` at
 * genesis, and returns what stops it.
 */
export async function startValidator(accounts: GenesisAccount[], port = RPC_PORT): Promise<() => Promise<void>> {
    const dir = await mkdtemp(join(tmpdir(), 'laterite-app-validator-'));
    const accountDir = join(dir, 'accounts');
    await mkdir(accountDir);
    for (const account of accounts) {
        await writeFile(join(accountDir, `${account.pubkey}.json`), JSON.stringify(account));
    }
    // prettier-ignore
    const args = [
        '--reset', '--quiet', '--ledger', join(dir, 'ledger'), '--account-dir', accountDir,
        '--rpc-port', String(port), '--gossip-port', String(port + 2),
        '--dynamic-port-range', `${port + 3}-${port + 60}`, '--faucet-port', String(port + 61),
        ...programs.flatMap(({ address, file }) => ['--bpf-program', address, fileURLToPath(file)]),
    ];
    const validator: ChildProcess = spawn('solana-test-validator', args, { stdio: 'ignore' });
    const exited = new Promise(resolve => validator.once('exit', resolve));
    const stop = async () => {
        validator.kill('SIGTERM');
        await exited;
        await rm(dir, { force: true, recursive: true });
    };
    for (let attempt = 0; attempt < 120; attempt++) {
        if (validator.exitCode !== null) break;
        // a transaction lands only once the chain has moved past its genesis slot
        const slot = await fetch(`http://127.0.0.1:${port}`, {
            body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'getSlot', params: [{ commitment: 'confirmed' }] }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        })
            .then(response => response.json() as Promise<{ result?: number }>)
            .then(({ result }) => result ?? 0)
            .catch(() => 0);
        if (slot > 0) return stop;
        await sleep(500);
    }
    await stop();
    throw new Error(`solana-test-validator did not start on port ${port}`);
}
