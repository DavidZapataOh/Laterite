import type { AddressInfo } from 'node:net';

import type { Database } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHealthServer } from '../src/health';
import { acquireLeadership } from '../src/leader';
import { createLogger } from '../src/log';

const log = createLogger('silent');
let db: Database;
let drop: () => Promise<void>;

beforeAll(async () => {
    ({ db, drop } = await createTestDatabase());
});
afterAll(() => drop());

describe('the operator lock', () => {
    it('lets one process operate at a time and passes to a waiting one when the first lets go', async () => {
        const first = await acquireLeadership(db, () => {});
        let secondHolds = false;
        const second = acquireLeadership(db, () => {}).then(release => ((secondHolds = true), release));
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(secondHolds).toBe(false);
        await first();
        await (
            await second
        )();
        expect(secondHolds).toBe(true);
    });
});

describe('the health endpoint', () => {
    it('answers 200 when every check passes and 503 with the failing one otherwise', async () => {
        let databaseUp = true;
        const server = await startHealthServer(
            0,
            {
                database: async () => {
                    if (!databaseUp) throw new Error('connection refused');
                    return { ok: true };
                },
                operator: async () => ({ alarms: [], ok: true, role: 'leader' }),
            },
            log,
        );
        const url = `http://[::1]:${(server.address() as AddressInfo).port}`;
        const healthy = await fetch(`${url}/health`);
        expect([healthy.status, await healthy.json()]).toEqual([
            200,
            { database: { ok: true }, operator: { alarms: [], ok: true, role: 'leader' }, status: 'ok' },
        ]);
        databaseUp = false;
        const failing = await fetch(`${url}/health`);
        expect([failing.status, (await failing.json()).database]).toEqual([
            503,
            { error: 'connection refused', ok: false },
        ]);
        expect((await fetch(`${url}/metrics`)).status).toBe(404);
        server.close();
    });
});
