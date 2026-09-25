import { readFileSync } from 'node:fs';

import {
    type Config,
    type EnrollParamsArgs,
    getOnboardingInstructions,
    LATERITE_PROGRAM_ADDRESS,
    PYTH_PRO_PROGRAM_ADDRESS,
} from '@laterite/client';
import { devnetConfigParams, ensureDeployment, MARKET_CALENDAR_FILE, readMarketCalendar } from '@laterite/deployment';
import { addresses as devnet } from '@laterite/devnet/addresses';
import {
    type Address,
    appendTransactionMessageInstructions,
    createTransactionMessage,
    getAddressEncoder,
    getCompiledTransactionMessageDecoder,
    getProgramDerivedAddress,
    getSignatureFromTransaction,
    getSolanaErrorFromTransactionError,
    getTransactionSize,
    type Instruction,
    type KeyPairSigner,
    lamports,
    pipe,
    type Rpc,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageLoadedAccountsDataSizeLimit,
    signTransactionMessageWithSigners,
    type SolanaRpcApi,
    type Transaction,
    type TransactionSigner,
} from '@solana/kit';
import { createRpcFromSvm } from '@solana/kit-plugin-litesvm';
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from 'litesvm';

import { ComputeLimitExceededError, type Landed, type Sender, TransactionFailedError } from '../../src/send';
import { genesisAccounts, keys } from './validator';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;
const SUBSCRIPTIONS_PROGRAM = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44' as Address;
const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;

/** A transaction error of LiteSVM's as Kit reads the cluster's (`InstructionError` with a custom code or another). */
function kitError(failure: FailedTransactionMetadata) {
    const error = failure.err() as { err?: () => unknown; index?: number };
    if (error.index === undefined || typeof error.err !== 'function') return new Error(failure.toString());
    const inner = error.err() as { code?: number };
    const detail = typeof inner === 'object' && inner?.code !== undefined ? { Custom: inner.code } : 'GenericError';
    return getSolanaErrorFromTransactionError({ InstructionError: [error.index, detail] } as never);
}

/**
 * LiteSVM with the program, the programs it calls and the local chain's genesis accounts, deployed as
 * `just devnet-deploy` does, its clock set by the test: the time-dependent crank tests run on it (Agave's test
 * validator follows wall time). Sends go straight to the SVM; a version 1 sweep is simulated first, as the crank's
 * sender does.
 */
export class SvmChain {
    config!: Config;
    readonly rpc: Rpc<SolanaRpcApi>;

    private constructor(readonly svm: LiteSVM) {
        const rpc = createRpcFromSvm(svm);
        // The pool reserves the devnet route quotes from are read as token balances.
        this.rpc = new Proxy(rpc, {
            get: (target, method) =>
                method === 'getTokenAccountBalance'
                    ? (address: Address) => ({
                          send: async () => {
                              const account = svm.getAccount(address);
                              if (!account.exists) throw new Error(`${address} does not exist`);
                              const amount = new DataView(account.data.buffer, account.data.byteOffset).getBigUint64(
                                  64,
                                  true,
                              );
                              return { value: { amount: amount.toString() } };
                          },
                      })
                    : Reflect.get(target, method),
        }) as unknown as Rpc<SolanaRpcApi>;
    }

    /** A chain at `now` (Unix seconds) with Laterite deployed and the NYSE calendar loaded from that day. */
    static async start(now: bigint): Promise<SvmChain> {
        const svm = new LiteSVM();
        const chain = new SvmChain(svm);
        chain.setNow(now);
        const fixtures = 'programs/laterite/tests/fixtures/';
        svm.addProgram(SUBSCRIPTIONS_PROGRAM, read(`${fixtures}subscriptions.so`));
        svm.addProgram(PYTH_PRO_PROGRAM_ADDRESS, read(`${fixtures}pyth_pro_devnet.so`));
        svm.addProgram(devnet.cpmm.program, read(`${fixtures}cpmm.so`));
        svm.addProgram(LATERITE_PROGRAM_ADDRESS, read('target/deploy/laterite.so'));
        const [authority, attestor, sponsor, crank, counterparty] = await Promise.all([
            keys.authority(),
            keys.attestor(),
            keys.sponsor(),
            keys.crank(),
            keys.counterparty(),
        ]);
        // The program is upgradeable by the tests' authority, which `initialize` requires.
        const [programData] = await getProgramDerivedAddress({
            programAddress: LOADER,
            seeds: [getAddressEncoder().encode(LATERITE_PROGRAM_ADDRESS)],
        });
        const data = chain.data(programData);
        data[12] = 1;
        data.set(getAddressEncoder().encode(authority.address), 13);
        chain.write(programData, data, LOADER);
        for (const account of await genesisAccounts(now)) {
            svm.setAccount({
                address: account.address,
                data: account.data,
                executable: false,
                lamports: lamports(account.lamports ?? 1_000_000_000n),
                programAddress: account.owner,
                space: BigInt(account.data.length),
            });
        }
        for (const signer of [authority, sponsor, crank, counterparty])
            svm.airdrop(signer.address, lamports(100_000_000_000n));
        const deployment = await ensureDeployment(chain, {
            authority,
            calendar: await readMarketCalendar(MARKET_CALENDAR_FILE),
            params: devnetConfigParams({
                attestor: attestor.address,
                genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
                sponsor: sponsor.address,
            }),
        });
        chain.config = deployment.config;
        return chain;
    }

    setNow(now: bigint) {
        const clock = this.svm.getClock();
        clock.unixTimestamp = now;
        this.svm.setClock(clock);
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

    /** Sends `instructions` in a version 0 transaction; each lands in its own slot, as on a cluster. */
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
        const result = this.land(transaction);
        if (result instanceof FailedTransactionMetadata) throw new Error(`Transaction failed: ${result.toString()}`);
        return getSignatureFromTransaction(transaction);
    }

    /** `user` enrolls, the sponsor paying, in one version 0 transaction without the lookup table. */
    async onboard(user: KeyPairSigner, params: EnrollParamsArgs) {
        const sponsor = await keys.sponsor();
        const { instructions } = await getOnboardingInstructions({
            config: this.config,
            params,
            rpc: this.rpc,
            sponsor,
            user,
        });
        return this.send(sponsor, instructions);
    }

    /**
     * The crank's sender on the SVM: simulated, limited to the simulation's units plus 10%, then sent. `extraUnits`
     * are added to what the simulation consumed, standing in for a route longer than the devnet pool's.
     */
    sender(payer: KeyPairSigner, extraUnits: () => number = () => 0): Pick<Sender, 'sendVersion1'> {
        return {
            sendVersion1: async (instructions, { maxComputeUnitLimit }) => {
                const message = (computeUnitLimit: number) =>
                    pipe(
                        createTransactionMessage({ version: 1 }),
                        m => setTransactionMessageFeePayerSigner(payer, m),
                        m =>
                            setTransactionMessageLifetimeUsingBlockhash(
                                { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 0n },
                                m,
                            ),
                        m => setTransactionMessageComputeUnitLimit(computeUnitLimit, m),
                        m => setTransactionMessageLoadedAccountsDataSizeLimit(MAX_LOADED_ACCOUNTS_DATA_SIZE, m),
                        m => appendTransactionMessageInstructions(instructions, m),
                    );
                const simulated = this.svm.simulateTransaction(
                    await signTransactionMessageWithSigners(message(1_400_000)),
                );
                if (simulated instanceof FailedTransactionMetadata) {
                    throw new TransactionFailedError(kitError(simulated), simulated.meta().logs());
                }
                const computeUnitLimit = Math.ceil(
                    (Number(simulated.meta().computeUnitsConsumed()) + extraUnits()) * 1.1,
                );
                if (computeUnitLimit > maxComputeUnitLimit) {
                    throw new ComputeLimitExceededError(computeUnitLimit, maxComputeUnitLimit);
                }
                const transaction = await signTransactionMessageWithSigners(message(computeUnitLimit));
                const signature = getSignatureFromTransaction(transaction);
                const result = this.land(transaction);
                if (result instanceof FailedTransactionMetadata) {
                    throw new TransactionFailedError(kitError(result), result.meta().logs(), signature);
                }
                return this.landed(transaction, result, computeUnitLimit);
            },
        };
    }

    private land(transaction: Transaction) {
        const result = this.svm.sendTransaction(transaction);
        const slot = this.svm.getClock().slot + 1n;
        this.svm.warpToSlot(slot);
        this.svm.expireBlockhash();
        const [latest] = this.svm.getSlotHashes();
        latest!.slot = slot;
        latest!.hash = this.svm.latestBlockhash();
        this.svm.setSlotHashes([latest!, ...this.svm.getSlotHashes()]);
        return result;
    }

    private landed(transaction: Transaction, result: TransactionMetadata, computeUnitLimit: number): Landed {
        const keys = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).staticAccounts;
        const executed = result.innerInstructions().flatMap(list =>
            list.map(inner => {
                const instruction = inner.instruction();
                return {
                    accounts: [...instruction.accounts()].map(index => keys[index]!),
                    data: instruction.data(),
                    programAddress: keys[instruction.programIdIndex()]!,
                };
            }),
        );
        return {
            computeUnitLimit,
            computeUnits: Number(result.computeUnitsConsumed()),
            executed,
            fee: 5_000n,
            loadedAccountsDataSizeLimit: MAX_LOADED_ACCOUNTS_DATA_SIZE,
            logs: result.logs(),
            priorityFeeLamports: 0n,
            signature: getSignatureFromTransaction(transaction),
            size: getTransactionSize(transaction),
        };
    }
}
