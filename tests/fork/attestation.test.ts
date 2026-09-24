import {
    EventKind,
    fetchUserConfig,
    findAttestationRecordPda,
    findUserConfigPda,
    getAttestInstructions,
    LATERITE_ERROR__INVALID_ATTESTATION_SIGNATURE,
} from '@laterite/client';
import { MAINNET_MINTS } from '@laterite/devnet';
import {
    appendTransactionMessageInstructions,
    createTransactionMessage,
    fetchEncodedAccount,
    getBase58Encoder,
    type Instruction,
    pipe,
    setTransactionMessageFeePayerSigner,
    type TransactionSigner,
} from '@solana/kit';
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { describe, expect, it } from 'vitest';

import { forkContext } from './src/deployment';
import { DOLLAR, lateriteError, fundToken, rpc, sendMessage, simulateMessage } from './src/fork';
import { report } from './src/report';
import { enroll, enrollParams } from './src/users';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const message = (payer: TransactionSigner, instructions: Instruction[]) =>
    pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(payer, m),
        m => appendTransactionMessageInstructions(instructions, m),
    );

describe('attestations on the fork', () => {
    it("credits a real payment signed by the fork's attestor for the fork's genesis hash, and no other", async () => {
        const fork = await forkContext();
        const { authority, attestor } = fork.keys;
        const { user } = await enroll(fork, enrollParams({ asset: 0, incomeRule: true, paymentTokens: 1 }));

        // A $60 salary paid to the user on the fork: the event the watcher attests.
        await fundToken(authority.address, MAINNET_MINTS.USDC, 60n * DOLLAR, TOKEN_PROGRAM_ADDRESS);
        const [[from], [to]] = await Promise.all([
            findAssociatedTokenPda({
                mint: MAINNET_MINTS.USDC,
                owner: authority.address,
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
            findAssociatedTokenPda({
                mint: MAINNET_MINTS.USDC,
                owner: user.address,
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
        ]);
        const payment = await sendMessage(
            message(authority, [
                getTransferCheckedInstruction({
                    amount: 60n * DOLLAR,
                    authority,
                    decimals: 6,
                    destination: to,
                    mint: MAINNET_MINTS.USDC,
                    source: from,
                }),
            ]),
        );
        const attestation = {
            amount: 60n * DOLLAR,
            eventTime: payment.blockTime!,
            kind: EventKind.Income,
            paymentToken: 0,
            signature: getBase58Encoder().encode(payment.signature),
            transferIndex: 0,
            user: user.address,
        };

        const genesisHash = getBase58Encoder().encode(await rpc.getGenesisHash().send());
        const forDevnet = await getAttestInstructions({
            attestation,
            attestor,
            genesisHash: getBase58Encoder().encode(DEVNET_GENESIS_HASH),
            payer: authority,
        });
        const refused = await simulateMessage(message(authority, forDevnet));
        expect(lateriteError(refused)).toBe(LATERITE_ERROR__INVALID_ATTESTATION_SIGNATURE);

        const landed = await sendMessage(
            message(authority, await getAttestInstructions({ attestation, attestor, genesisHash, payer: authority })),
        );
        const { data } = await fetchUserConfig(rpc, (await findUserConfigPda({ user: user.address }))[0]);
        expect(data.pending).toBe(6n * DOLLAR);
        expect((await fetchEncodedAccount(rpc, (await findAttestationRecordPda(attestation))[0])).exists).toBe(true);
        report('attestation', [{ signature: landed.signature, bytes: landed.size, units: landed.units }]);
    });
});
