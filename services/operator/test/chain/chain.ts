import {
    type AttestationArgs,
    type Config,
    createSponsoredTransactionMessage,
    createSweepTransactionMessage,
    Engine,
    type EnrollParamsArgs,
    fetchConfig,
    fetchPythStorage,
    fetchSweepState,
    fetchUserConfig,
    findConfigPda,
    findSwapAuthorityPda,
    findUserConfigPda,
    getAttestInstructions,
    getChangePaymentTokensInstructions,
    getChangeTierInstructions,
    getCloseAttestationInstruction,
    getExitInstructions,
    getLowerPendingInstructions,
    getOnboardingInstructions,
    getReactivationInstructions,
    getSetUserPausedInstructions,
    getSweepInstructions,
    getSweepPull,
    getUpdateSettingsInstructions,
    type Quote,
    pullTotal,
} from '@laterite/client';
import { devnetConfigParams, ensureDeployment, MARKET_CALENDAR_FILE, readMarketCalendar } from '@laterite/deployment';
import { createClient, routeInstruction } from '@laterite/devnet';
import { addresses as devnet } from '@laterite/devnet/addresses';
import {
    type Address,
    type AddressesByLookupTableAddress,
    estimateAndSetResourceLimitsFactory,
    estimateResourceLimitsFactory,
    getAddressEncoder,
    getSignatureFromTransaction,
    type Instruction,
    lamports,
    type MicroLamports,
    type Signature,
    sendAndConfirmTransactionFactory,
    setTransactionMessageLifetimeUsingBlockhash,
    signBytes,
    signTransactionMessageWithSigners,
    type KeyPairSigner,
    appendTransactionMessageInstructions,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    pipe,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageFeePayerSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { getUpdateMultiplierScaledUiMintInstruction } from '@solana-program/token-2022';
import { fetchAddressLookupTable } from '@solana-program/address-lookup-table';
import { findAssociatedTokenPda } from '@solana-program/token';

import { keys, SPYX_QUOTE, startValidator, type Validator } from './validator';

const DOLLAR = 1_000_000n;

/** SPYx and $1 a day on the $10 tier from `paymentTokens`, as a new user picks in the app. */
export const params = (paymentTokens: number, overrides: Partial<EnrollParamsArgs> = {}): EnrollParamsArgs => ({
    asset: 0,
    changeMultiplier: 0,
    cushions: [20n * DOLLAR, 20n * DOLLAR],
    engine: Engine.Daily,
    engineAmount: DOLLAR,
    goalAmount: 1_000n * DOLLAR,
    goalLabel: new Uint8Array(32),
    incomeRule: false,
    paymentTokens,
    tier: 0,
    ...overrides,
});

/** A Solana-format update of `feeds` at `at`, signed by the key the local Pyth Pro storage trusts. */
async function pythUpdate(at: bigint, feeds: [number, Quote][]): Promise<Uint8Array> {
    const payload: number[] = [];
    const push = (bytes: ArrayLike<number>) => payload.push(...Array.from(bytes));
    const le = (value: bigint, size: number) =>
        Array.from({ length: size }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));
    const micros = le(at * 1_000_000n, 8);
    push(le(2_479_346_549n, 4));
    push(micros);
    push([3, feeds.length]);
    for (const [id, { confidence, exponent, price }] of feeds) {
        push(le(BigInt(id), 4));
        push([4, 0]);
        push(le(price, 8));
        push([4]);
        push(le(BigInt.asUintN(16, BigInt(exponent)), 2));
        push([5]);
        push(le(confidence, 8));
        push([12, 1]);
        push(micros);
    }
    const signer = await keys.pythSigner();
    const bytes = new Uint8Array(payload);
    const signature = await signBytes(signer.keyPair.privateKey, bytes);
    return new Uint8Array([
        ...le(2_182_742_457n, 4),
        ...signature,
        ...getAddressEncoder().encode(signer.address),
        ...le(BigInt(bytes.length), 2),
        ...bytes,
    ]);
}

/** A local chain with Laterite deployed as on devnet, and the transactions users, the crank and the watcher send. */
export class Chain {
    config!: Config;
    lookupTable!: AddressesByLookupTableAddress;
    readonly rpc;
    private readonly client;
    private readonly estimate;
    private readonly sendAndConfirm;

    private constructor(readonly validator: Validator) {
        this.client = createClient(validator.rpcUrl, validator.wsUrl);
        this.rpc = this.client.rpc;
        const estimate = estimateResourceLimitsFactory({ rpc: this.rpc });
        this.estimate = estimateAndSetResourceLimitsFactory((async (message, config) => {
            const limits = await estimate(message, config);
            const margin = (limit: number) => Math.ceil(limit * 1.1);
            return {
                computeUnitLimit: margin(limits.computeUnitLimit),
                ...(limits.loadedAccountsDataSizeLimit !== undefined && {
                    loadedAccountsDataSizeLimit: margin(limits.loadedAccountsDataSizeLimit),
                }),
            };
        }) as typeof estimate);
        this.sendAndConfirm = sendAndConfirmTransactionFactory({
            rpc: this.rpc,
            rpcSubscriptions: this.client.rpcSubscriptions,
        });
    }

    /** A new chain with the deployment `just devnet-deploy` makes: config, plans, swap accounts, calendar and table. */
    static async start(): Promise<Chain> {
        const chain = new Chain(await startValidator());
        const [authority, attestor, sponsor, crank] = await Promise.all([
            keys.authority(),
            keys.attestor(),
            keys.sponsor(),
            keys.crank(),
        ]);
        for (const address of [authority.address, sponsor.address, crank.address]) {
            const signature = await chain.rpc.requestAirdrop(address, lamports(100_000_000_000n)).send();
            await chain.confirmed(signature);
        }
        const genesisHash = await chain.rpc.getGenesisHash().send();
        const deployment = await ensureDeployment(chain.client, {
            authority,
            calendar: await readMarketCalendar(MARKET_CALENDAR_FILE),
            params: devnetConfigParams({ attestor: attestor.address, genesisHash, sponsor: sponsor.address }),
        });
        chain.config = deployment.config;
        // Simulations read finalized state, which must hold the lookup table before a sponsored transaction uses it.
        const tableAddress = deployment.lookupTable!;
        while (
            !(await chain.rpc.getAccountInfo(tableAddress, { commitment: 'finalized', encoding: 'base64' }).send())
                .value
        ) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        const { data: table } = await fetchAddressLookupTable(chain.rpc, tableAddress);
        chain.lookupTable = { [tableAddress]: table.addresses };
        return chain;
    }

    stop() {
        return this.validator.stop();
    }

    private async confirmed(signature: Signature) {
        for (;;) {
            const { value } = await this.rpc.getSignatureStatuses([signature]).send();
            if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') return;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    private async sendMessage(message: Parameters<typeof this.estimate>[0]): Promise<Signature> {
        const { value: blockhash } = await this.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
        const transaction = await signTransactionMessageWithSigners(
            await this.estimate(setTransactionMessageLifetimeUsingBlockhash(blockhash, message as never)),
        );
        await this.sendAndConfirm(transaction as never, { commitment: 'confirmed' });
        return getSignatureFromTransaction(transaction);
    }

    /** Sends a user's instructions as the sponsored version 0 transaction the app builds. */
    async sponsored(instructions: readonly Instruction[]): Promise<Signature> {
        return this.sendMessage(
            createSponsoredTransactionMessage({
                computeUnitPrice: 1_000n as MicroLamports,
                instructions,
                lookupTable: this.lookupTable,
                sponsor: await keys.sponsor(),
            }),
        );
    }

    async userConfig(user: Address) {
        return (await fetchUserConfig(this.rpc, (await findUserConfigPda({ user }))[0])).data;
    }

    async refreshConfig() {
        return (this.config = (await fetchConfig(this.rpc, (await findConfigPda())[0])).data);
    }

    async onboard(user: KeyPairSigner, enroll: EnrollParamsArgs) {
        const { instructions } = await getOnboardingInstructions({
            config: this.config,
            params: enroll,
            rpc: this.rpc,
            sponsor: await keys.sponsor(),
            user,
        });
        return this.sponsored(instructions);
    }

    /** The crank's USDC sweep of `user` through the CPMM, priced by an SPYx update composed now. */
    async sweep(user: KeyPairSigner): Promise<Signature> {
        const crank = await keys.crank();
        const state = await fetchSweepState(this.rpc, { config: this.config, paymentToken: 0, user: user.address });
        const pull = getSweepPull(state);
        const asset = this.config.assets[0]!;
        const assetUpdate = await pythUpdate(state.now, [[asset.pythFeedId, SPYX_QUOTE]]);
        const [[swapAuthority], [destination], storage] = await Promise.all([
            findSwapAuthorityPda(),
            findAssociatedTokenPda({ mint: asset.mint, owner: user.address, tokenProgram: asset.tokenProgram }),
            fetchPythStorage(this.rpc),
        ]);
        const route = await routeInstruction({
            amountIn: pullTotal(pull),
            ammConfig: devnet.cpmm.ammConfig,
            authority: swapAuthority,
            destination,
            pool: devnet.pools['SPYx-USDC'],
            tokens: devnet.tokens,
        });
        const sweep = await getSweepInstructions({ assetUpdate, crank, pythTreasury: storage.treasury, route, state });
        return this.sendMessage(createSweepTransactionMessage({ crank, instructions: sweep.instructions }));
    }

    async updateSettings(user: KeyPairSigner, next: EnrollParamsArgs) {
        const { instructions } = await getUpdateSettingsInstructions({
            config: this.config,
            params: next,
            rpc: this.rpc,
            sponsor: await keys.sponsor(),
            user,
        });
        return this.sponsored(instructions);
    }

    async setPaused(user: KeyPairSigner, paused: boolean) {
        const userConfig = await this.userConfig(user.address);
        return this.sponsored(await getSetUserPausedInstructions({ paused, user, userConfig }));
    }

    async lowerPending(user: KeyPairSigner, pending: bigint) {
        const userConfig = await this.userConfig(user.address);
        return this.sponsored(await getLowerPendingInstructions({ pending, user, userConfig }));
    }

    async changeTier(user: KeyPairSigner, tier: number) {
        const input = { config: this.config, rpc: this.rpc, sponsor: await keys.sponsor(), tier, user };
        return this.sponsored(await getChangeTierInstructions(input));
    }

    async changePaymentTokens(user: KeyPairSigner, paymentTokens: number) {
        const input = { config: this.config, paymentTokens, rpc: this.rpc, sponsor: await keys.sponsor(), user };
        return this.sponsored(await getChangePaymentTokensInstructions(input));
    }

    async exit(user: KeyPairSigner) {
        return this.sponsored(await getExitInstructions({ config: this.config, rpc: this.rpc, user }));
    }

    async reactivate(user: KeyPairSigner, enroll: EnrollParamsArgs) {
        const { instructions } = await getReactivationInstructions({
            config: this.config,
            params: enroll,
            rpc: this.rpc,
            sponsor: await keys.sponsor(),
            user,
        });
        return this.sponsored(instructions);
    }

    /** The watcher's `[ed25519, attest]` pair for `attestation`, the crank paying the fee and the record's rent. */
    async attest(attestation: AttestationArgs): Promise<Signature> {
        const crank = await keys.crank();
        const instructions = await getAttestInstructions({
            attestation,
            attestor: await keys.attestor(),
            genesisHash: this.config.genesisHash,
            payer: crank,
        });
        return this.sendMessage(
            createSponsoredTransactionMessage({
                computeUnitPrice: 1_000n as MicroLamports,
                instructions,
                lookupTable: {},
                sponsor: crank,
            }),
        );
    }

    /**
     * `attestation`'s pair followed by a transfer the crank cannot afford: the transaction fails after `attest` logged
     * its event, and lands anyway, as a failed transaction does.
     */
    async attestThenFail(attestation: AttestationArgs): Promise<Signature> {
        const crank = await keys.crank();
        const instructions = await getAttestInstructions({
            attestation,
            attestor: await keys.attestor(),
            genesisHash: this.config.genesisHash,
            payer: crank,
        });
        const overdraft = getTransferSolInstruction({
            amount: 2n ** 62n,
            destination: attestation.user,
            source: crank,
        });
        const { value: blockhash } = await this.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
        const transaction = await signTransactionMessageWithSigners(
            pipe(
                createTransactionMessage({ version: 0 }),
                message => setTransactionMessageFeePayerSigner(crank, message),
                message => setTransactionMessageLifetimeUsingBlockhash(blockhash, message),
                message => setTransactionMessageComputeUnitLimit(100_000, message),
                message => appendTransactionMessageInstructions([...instructions, overdraft], message),
            ),
        );
        const signature = getSignatureFromTransaction(transaction);
        await this.rpc
            .sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', skipPreflight: true })
            .send();
        await this.confirmed(signature);
        return signature;
    }

    /** Closes an expired attestation record, its rent back to `payer`. */
    async closeAttestation(record: Address, payer: Address): Promise<Signature> {
        const crank = await keys.crank();
        return this.sendMessage(
            createSponsoredTransactionMessage({
                computeUnitPrice: 1_000n as MicroLamports,
                instructions: [getCloseAttestationInstruction({ payer, record })],
                lookupTable: {},
                sponsor: crank,
            }),
        );
    }

    /** Schedules SPYx's next ScaledUiAmount multiplier, as its issuer announces a corporate action. */
    async scheduleMultiplier(multiplier: number, effectiveTimestamp: bigint): Promise<Signature> {
        const crank = await keys.crank();
        const update = getUpdateMultiplierScaledUiMintInstruction({
            authority: await keys.issuer(),
            effectiveTimestamp,
            mint: devnet.tokens.SPYx.mint,
            multiplier,
        });
        return this.sendMessage(
            createSponsoredTransactionMessage({
                computeUnitPrice: 1_000n as MicroLamports,
                instructions: [update],
                lookupTable: {},
                sponsor: crank,
            }),
        );
    }

    /** Waits until `signature` is finalized, as the indexer reads. */
    async finalized(signature: Signature) {
        for (;;) {
            const { value } = await this.rpc.getSignatureStatuses([signature]).send();
            if (value[0]?.confirmationStatus === 'finalized') return;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}
