import { readFileSync } from 'node:fs';

import { addresses as devnet } from '@laterite/devnet/addresses';
import { LATERITE_PROGRAM_ADDRESS } from '@laterite/client';
import {
    type Address,
    appendTransactionMessageInstructions,
    createTransactionMessage,
    generateKeyPairSigner,
    getAddressEncoder,
    getProgramDerivedAddress,
    getSignatureFromTransaction,
    type Instruction,
    type KeyPairSigner,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type TransactionSigner,
} from '@solana/kit';
import { createRpcFromSvm } from '@solana/kit-plugin-litesvm';
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from '@solana/subscriptions';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';

import type { Cluster } from '../../src';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;

/** A LiteSVM cluster with the program deployed under `authority`, Subscriptions, and the devnet tables' mints. */
export class TestCluster implements Cluster {
    readonly rpc;
    sent = 0;

    private constructor(
        readonly svm: LiteSVM,
        readonly authority: KeyPairSigner,
    ) {
        this.rpc = createRpcFromSvm(svm);
    }

    static async create() {
        const svm = new LiteSVM();
        const cluster = new TestCluster(svm, await generateKeyPairSigner());
        svm.addProgram(SUBSCRIPTIONS_PROGRAM_ADDRESS, read('programs/laterite/tests/fixtures/subscriptions.so'));
        svm.addProgram(LATERITE_PROGRAM_ADDRESS, read('target/deploy/laterite.so'));
        const [programData] = await getProgramDerivedAddress({
            programAddress: LOADER,
            seeds: [getAddressEncoder().encode(LATERITE_PROGRAM_ADDRESS)],
        });
        const data = cluster.data(programData);
        data[12] = 1;
        data.set(getAddressEncoder().encode(cluster.authority.address), 13);
        cluster.write(programData, data, LOADER);
        for (const token of Object.values(devnet.tokens)) {
            const mint = new Uint8Array(82);
            mint[44] = token.decimals;
            mint[45] = 1;
            cluster.write(token.mint, mint, token.tokenProgram);
        }
        svm.airdrop(cluster.authority.address, lamports(100_000_000_000n));
        return cluster;
    }

    data(address: Address): Uint8Array {
        const account = this.svm.getAccount(address);
        if (!account.exists) throw new Error(`${address} does not exist`);
        return new Uint8Array(account.data);
    }

    write(address: Address, data: Uint8Array, owner: Address) {
        this.svm.setAccount({
            address,
            data,
            executable: false,
            lamports: lamports(this.svm.minimumBalanceForRentExemption(BigInt(data.length))),
            programAddress: owner,
            space: BigInt(data.length),
        });
    }

    async send(feePayer: TransactionSigner, instructions: Instruction[]) {
        const transaction = await signTransactionMessageWithSigners(
            pipe(
                createTransactionMessage({ version: 0 }),
                message => setTransactionMessageFeePayerSigner(feePayer, message),
                message =>
                    setTransactionMessageLifetimeUsingBlockhash(
                        { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 0n },
                        message,
                    ),
                message => appendTransactionMessageInstructions(instructions, message),
            ),
        );
        const result = this.svm.sendTransaction(transaction);
        if (result instanceof FailedTransactionMetadata) throw new Error(`Transaction failed: ${result.toString()}`);
        this.sent += 1;
        // Each transaction lands in its own slot, as on a cluster, so a lookup table's addresses resolve in the next
        // one; the new slot joins SlotHashes as a cluster's finalized slot does, since `getSlot` answers with it.
        const slot = this.svm.getClock().slot + 1n;
        this.svm.warpToSlot(slot);
        this.svm.expireBlockhash();
        const [latest] = this.svm.getSlotHashes();
        latest!.slot = slot;
        latest!.hash = this.svm.latestBlockhash();
        this.svm.setSlotHashes([latest!, ...this.svm.getSlotHashes()]);
        return getSignatureFromTransaction(transaction);
    }

    setDay(day: bigint) {
        const clock = this.svm.getClock();
        clock.unixTimestamp = day * 86_400n + 50_000n;
        this.svm.setClock(clock);
    }
}
