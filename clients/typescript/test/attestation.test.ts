import type { ReadonlyUint8Array } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import {
    ATTESTATION_TTL_SECONDS,
    type AttestationArgs,
    EventKind,
    findAttestationRecordPda,
    getAttestInstructions,
    getCloseAttestationInstruction,
    LATERITE_ERROR__INVALID_ATTESTATION_SIGNATURE,
} from '../src';
import { customCode, defaultParams, enrolled, programUnits, withPlans } from './env';
import {
    attestorSigner,
    DEVNET_GENESIS_HASH,
    DOLLAR,
    MAINNET_GENESIS_HASH,
    NOW,
    seeded,
    sponsorSigner,
} from './fixtures';

const income = (user: AttestationArgs['user'], tag: number): AttestationArgs => ({
    amount: 100n * DOLLAR,
    eventTime: NOW + 60n,
    kind: EventKind.Income,
    paymentToken: 0,
    signature: new Uint8Array(64).fill(tag),
    transferIndex: 0,
    user,
});

/** A user `[9; 32]` enrolled with the income rule, the clock two minutes after enrollment. */
async function attestationEnv(genesisHash?: ReadonlyUint8Array) {
    const env = await withPlans(genesisHash);
    const user = await seeded(9);
    await enrolled(env, user, { ...defaultParams(), changeMultiplier: 1, incomeRule: true });
    env.setNow(NOW + 120n);
    return { env, sponsor: await sponsorSigner(), user };
}

describe('attestation builder', () => {
    it('lands one [ed25519, attest] pair at the CU baseline', async () => {
        const { env, sponsor, user } = await attestationEnv();
        const instructions = await getAttestInstructions({
            attestation: income(user.address, 1),
            attestor: await attestorSigner(),
            genesisHash: env.config!.genesisHash,
            payer: sponsor,
        });
        const outcome = await env.expectSuccess(env.send(sponsor, instructions));
        expect([outcome.size, outcome.result.computeUnitsConsumed(), programUnits(outcome.result)]).toEqual([
            784,
            14_571n,
            14_571n,
        ]);
        expect(instructions[0].data!.length).toBe(16 + 32 + 64 + 203);
        expect((await env.userConfig(user.address)).pending).toBe(10n * DOLLAR);
    });

    it('lands several pairs in one transaction and closes an expired record to its payer', async () => {
        const { env, sponsor, user } = await attestationEnv();
        const attestor = await attestorSigner();
        const pairs = await Promise.all(
            [2, 3].map(tag =>
                getAttestInstructions({
                    attestation: income(user.address, tag),
                    attestor,
                    genesisHash: env.config!.genesisHash,
                    payer: sponsor,
                }),
            ),
        );
        await env.expectSuccess(env.send(sponsor, pairs.flat()));
        expect((await env.userConfig(user.address)).pending).toBe(20n * DOLLAR);

        const [record] = await findAttestationRecordPda(income(user.address, 2));
        const rent = env.balance(record);
        env.setNow(NOW + 60n + ATTESTATION_TTL_SECONDS + 1n);
        const before = env.balance(sponsor.address);
        const close = getCloseAttestationInstruction({ payer: sponsor.address, record });
        const outcome = await env.expectSuccess(env.send(sponsor, [close]));
        expect(env.exists(record)).toBe(false);
        expect(env.balance(sponsor.address)).toBe(before + rent - 5_000n);
        expect(outcome.size).toBe(213);
    });

    it("refuses on a mainnet deployment a message signed for devnet's genesis hash", async () => {
        const { env, sponsor, user } = await attestationEnv(MAINNET_GENESIS_HASH);
        const attestor = await attestorSigner();
        const devnetSigned = await getAttestInstructions({
            attestation: income(user.address, 4),
            attestor,
            genesisHash: DEVNET_GENESIS_HASH,
            payer: sponsor,
        });
        expect(customCode(await env.send(sponsor, devnetSigned))).toBe(LATERITE_ERROR__INVALID_ATTESTATION_SIGNATURE);
        const mainnetSigned = await getAttestInstructions({
            attestation: income(user.address, 4),
            attestor,
            genesisHash: env.config!.genesisHash,
            payer: sponsor,
        });
        await env.expectSuccess(env.send(sponsor, mainnetSigned));
    });
});
