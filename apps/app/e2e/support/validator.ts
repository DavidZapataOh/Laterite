import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
    Engine,
    findUserConfigPda,
    getUserConfigEncoder,
    LATERITE_PROGRAM_ADDRESS,
    UserStatus,
} from '@laterite/client';
import { type Address, getBase64Decoder } from '@solana/kit';

import { ENROLLED_AT, users } from './keys';

/** The validator's RPC port (its WebSocket on the next one); its other ports follow it. */
export const RPC_PORT = 48_899;

async function userConfig(user: Address, tier: number, status: UserStatus) {
    const [address, bump] = await findUserConfigPda({ user });
    const data = getUserConfigEncoder().encode({
        asset: 0,
        attestableFrom: ENROLLED_AT,
        bump,
        changeMultiplier: 0,
        cushions: [20_000_000n, 20_000_000n],
        engine: Engine.Daily,
        engineAmount: 1_000_000n,
        engineRanAt: 0n,
        enrolledAt: ENROLLED_AT,
        goalAmount: 0n,
        goalLabel: new Uint8Array(32),
        incomeRule: true,
        lastSweepDay: [0, 0],
        paymentTokens: 1,
        pending: 0n,
        status,
        tier,
        user,
        week: 0,
        weekSpent: 0n,
    });
    return {
        account: {
            data: [getBase64Decoder().decode(data), 'base64'],
            executable: false,
            lamports: 1_483_360,
            owner: LATERITE_PROGRAM_ADDRESS,
            rentEpoch: 0,
            space: data.length,
        },
        pubkey: address,
    };
}

/**
 * Starts a new chain on Agave's test validator holding the `UserConfig` of every genesis user in {@link users}, and
 * returns what stops it.
 */
export async function startValidator(): Promise<() => Promise<void>> {
    const dir = await mkdtemp(join(tmpdir(), 'laterite-app-validator-'));
    const accounts = join(dir, 'accounts');
    await mkdir(accounts);
    for (const account of await Promise.all([
        userConfig(users.active.address, 1, UserStatus.Active),
        userConfig(users.paused.address, 0, UserStatus.Paused),
        userConfig(users.exited.address, 1, UserStatus.Exited),
    ])) {
        await writeFile(join(accounts, `${account.pubkey}.json`), JSON.stringify(account));
    }
    // prettier-ignore
    const args = [
        '--reset', '--quiet', '--ledger', join(dir, 'ledger'), '--account-dir', accounts,
        '--rpc-port', String(RPC_PORT), '--gossip-port', String(RPC_PORT + 2),
        '--dynamic-port-range', `${RPC_PORT + 3}-${RPC_PORT + 60}`, '--faucet-port', String(RPC_PORT + 61),
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
        const healthy = await fetch(`http://127.0.0.1:${RPC_PORT}`, {
            body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'getHealth' }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        })
            .then(response => response.ok)
            .catch(() => false);
        if (healthy) return stop;
        await sleep(500);
    }
    await stop();
    throw new Error(`solana-test-validator did not start on port ${RPC_PORT}`);
}
