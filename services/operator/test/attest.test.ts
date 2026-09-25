import {
    ATTESTATION_TTL_SECONDS,
    type AttestationArgs,
    Engine,
    EventKind,
    getUserConfigDecoder,
    getUserConfigEncoder,
    LATERITE_ERROR__ATTESTATION_EXPIRED,
    LATERITE_ERROR__INVALID_ATTESTATION,
    LATERITE_ERROR__NOTHING_TO_INVEST,
    LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN,
    LATERITE_ERROR__USER_NOT_ACTIVE,
    type PaymentToken,
    UserStatus,
    type UserConfigArgs,
} from '@laterite/client';
import {
    AccountRole,
    type Address,
    appendTransactionMessageInstructions,
    type Blockhash,
    compileTransaction,
    createTransactionMessage,
    getBase58Decoder,
    getBase64EncodedWireTransaction,
    getCompiledTransactionMessageDecoder,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
    getTransferCheckedInstructionDataEncoder,
    getTransferInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { describe, expect, it } from 'vitest';

import { recentPriorityFee } from '../src/send';
import type { FetchedTransaction } from '../src/transaction';
import { getAttestations, getPaymentTransfers } from '../src/watcher/transfers';
import { attestRefusal, deploymentMismatch } from '../src/watcher/refusals';

let keys = 0;
const key = () => getBase58Decoder().decode(new Uint8Array(32).fill(++keys)) as Address;
const USER = key();
const OTHER = key();
const SWAP = key();
const USDC = key();
const USDT = key();
const BONK = key();
const ROUTER = key();
const PAYER = key();
const paymentTokens: PaymentToken[] = [USDC, USDT].map(mint => ({
    decimals: 6,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    usdFeedId: 0,
}));
const tokenAccounts = new Map<string, Address>();
/** `owner`'s token account in `mint`. */
const account = (owner: Address, mint: Address) => {
    if (!tokenAccounts.has(owner + mint)) tokenAccounts.set(owner + mint, key());
    return tokenAccounts.get(owner + mint)!;
};

/**
 * A successful transaction whose top-level instructions are a router call that invoked a USDT `TransferChecked` from
 * the user and a transfer of another mint to the user, then a plain USDC `Transfer` to the user.
 */
function routedTransaction(): FetchedTransaction {
    const plainUsdc = getTransferInstruction({
        amount: 70n,
        authority: PAYER,
        destination: account(USER, USDC),
        source: account(OTHER, USDC),
    });
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayer(PAYER, m),
        m =>
            setTransactionMessageLifetimeUsingBlockhash(
                { blockhash: USER as unknown as Blockhash, lastValidBlockHeight: 0n },
                m,
            ),
        m =>
            appendTransactionMessageInstructions(
                [
                    {
                        accounts: [
                            account(USER, USDT),
                            USDT,
                            account(SWAP, USDT),
                            account(OTHER, BONK),
                            account(USER, BONK),
                            account(OTHER, USDC),
                        ]
                            .map(address => ({ address, role: AccountRole.WRITABLE }))
                            .concat({ address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY }),
                        programAddress: ROUTER,
                    },
                    plainUsdc,
                ],
                m,
            ),
    );
    const transaction = compileTransaction(message);
    const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    const index = (key: Address) => staticAccounts.indexOf(key);
    const checked = (amount: bigint) =>
        getBase58Decoder().decode(getTransferCheckedInstructionDataEncoder().encode({ amount, decimals: 6 }));
    const plain = (amount: bigint) =>
        getBase58Decoder().decode(new Uint8Array([3, ...new Uint8Array(new BigUint64Array([amount]).buffer)]));
    const balance = (owner: Address, mint: Address) => ({ accountIndex: index(account(owner, mint)), mint, owner });
    return {
        blockTime: 1_790_000_000n,
        meta: {
            err: null,
            innerInstructions: [
                {
                    index: 0,
                    instructions: [
                        {
                            accounts: [account(USER, USDT), USDT, account(SWAP, USDT), account(USER, USDT)].map(index),
                            data: checked(3_000_000n),
                            programIdIndex: index(TOKEN_PROGRAM_ADDRESS),
                        },
                        {
                            accounts: [account(OTHER, BONK), account(USER, BONK), account(OTHER, BONK)].map(index),
                            data: plain(9n),
                            programIdIndex: index(TOKEN_PROGRAM_ADDRESS),
                        },
                    ],
                },
            ],
            logMessages: [],
            postTokenBalances: [balance(USER, USDC), balance(OTHER, USDC)],
            preTokenBalances: [
                balance(USER, USDT),
                balance(SWAP, USDT),
                balance(OTHER, BONK),
                balance(USER, BONK),
                balance(OTHER, USDC),
            ],
        },
        slot: 1n,
        transaction: [getBase64EncodedWireTransaction(transaction), 'base64'],
    };
}

const user = (overrides: Partial<UserConfigArgs> = {}) =>
    getUserConfigDecoder().decode(
        getUserConfigEncoder().encode({
            asset: 0,
            attestableFrom: 1_000n,
            bump: 255,
            changeMultiplier: 1,
            cushions: [0n, 0n],
            engine: Engine.Daily,
            engineAmount: 1_000_000n,
            engineRanAt: 0n,
            enrolledAt: 1_000n,
            goalAmount: 0n,
            goalLabel: new Uint8Array(32),
            incomeRule: true,
            lastSweepDay: [0, 0],
            paymentTokens: 0b01,
            pending: 0n,
            status: UserStatus.Active,
            tier: 0,
            user: USER,
            week: 0,
            weekSpent: 0n,
            ...overrides,
        }),
    );

const attestation = (overrides: Partial<AttestationArgs> = {}): AttestationArgs => ({
    amount: 100_000_000n,
    eventTime: 2_000n,
    kind: EventKind.Income,
    paymentToken: 0,
    signature: new Uint8Array(64),
    transferIndex: 0,
    user: USER,
    ...overrides,
});

describe('payment transfers', () => {
    it("numbers the user's payment-token transfers in execution order, whatever the token", () => {
        const transfers = getPaymentTransfers(routedTransaction(), USER, paymentTokens);
        expect(transfers).toEqual([
            {
                amount: 3_000_000n,
                destination: account(SWAP, USDT),
                destinationOwner: SWAP,
                index: 0,
                paymentToken: 1,
                source: account(USER, USDT),
                sourceOwner: USER,
            },
            {
                amount: 70n,
                destination: account(USER, USDC),
                destinationOwner: USER,
                index: 1,
                paymentToken: 0,
                source: account(OTHER, USDC),
                sourceOwner: OTHER,
            },
        ]);
    });

    it("attests each watched account's own side, never a pull into the swap authority", () => {
        const signature = getBase58Decoder().decode(new Uint8Array(64).fill(7)) as never;
        const watched = (mint: Address, paymentToken: number) => ({
            address: account(USER, mint),
            paymentToken,
            user: USER,
        });
        expect(getAttestations(signature, routedTransaction(), watched(USDC, 0), paymentTokens, SWAP)).toEqual([
            {
                amount: 70n,
                eventTime: 1_790_000_000n,
                kind: EventKind.Income,
                paymentToken: 0,
                signature: new Uint8Array(64).fill(7),
                transferIndex: 1,
                user: USER,
            },
        ]);
        expect(getAttestations(signature, routedTransaction(), watched(USDT, 1), paymentTokens, SWAP)).toEqual([]);
        expect(getAttestations(signature, routedTransaction(), watched(USDT, 1), paymentTokens, OTHER)).toMatchObject([
            { amount: 3_000_000n, kind: EventKind.Payment, paymentToken: 1, transferIndex: 0 },
        ]);
        const failed = routedTransaction();
        failed.meta!.err = { InstructionError: [1, 'InvalidArgument'] };
        expect(getAttestations(signature, failed, watched(USDC, 0), paymentTokens, SWAP)).toEqual([]);
    });
});

describe('what attest refuses', () => {
    const now = 3_000n;

    it("follows the program's order", () => {
        expect(attestRefusal(user({ status: UserStatus.Paused }), attestation({ amount: 0n }), now)).toBe(
            LATERITE_ERROR__USER_NOT_ACTIVE,
        );
        expect(attestRefusal(user({ status: UserStatus.Exited }), attestation(), now)).toBe(
            LATERITE_ERROR__USER_NOT_ACTIVE,
        );
        expect(attestRefusal(user(), attestation({ amount: 0n }), now)).toBe(LATERITE_ERROR__INVALID_ATTESTATION);
        expect(attestRefusal(user(), attestation({ eventTime: 999n }), now)).toBe(LATERITE_ERROR__INVALID_ATTESTATION);
        expect(attestRefusal(user(), attestation({ eventTime: now + 1n }), now)).toBe(
            LATERITE_ERROR__INVALID_ATTESTATION,
        );
        expect(attestRefusal(user(), attestation({ paymentToken: 1 }), now)).toBe(
            LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN,
        );
        expect(attestRefusal(user(), attestation({ paymentToken: 2 }), now)).toBe(
            LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN,
        );
    });

    it('keeps the 7-day window inclusive', () => {
        const end = 2_000n + ATTESTATION_TTL_SECONDS;
        expect(attestRefusal(user(), attestation(), end)).toBeNull();
        expect(attestRefusal(user(), attestation(), end + 1n)).toBe(LATERITE_ERROR__ATTESTATION_EXPIRED);
        expect(attestRefusal(user(), attestation({ eventTime: 1_000n }), now)).toBeNull();
    });

    it("asks the user's rules for a positive amount", () => {
        expect(attestRefusal(user(), attestation({ amount: 49_999_999n }), now)).toBe(
            LATERITE_ERROR__NOTHING_TO_INVEST,
        );
        expect(attestRefusal(user(), attestation({ amount: 50_000_000n }), now)).toBeNull();
        expect(attestRefusal(user({ incomeRule: false }), attestation(), now)).toBe(LATERITE_ERROR__NOTHING_TO_INVEST);
        expect(attestRefusal(user(), attestation({ amount: 3_000_000n, kind: EventKind.Payment }), now)).toBeNull();
        expect(attestRefusal(user({ changeMultiplier: 0 }), attestation({ kind: EventKind.Payment }), now)).toBe(
            LATERITE_ERROR__NOTHING_TO_INVEST,
        );
    });
});

describe('the deployment check', () => {
    it("names the config's attestor when it is not the service's key", () => {
        const config = { attestor: OTHER, genesisHash: new Uint8Array(32) } as never;
        expect(deploymentMismatch(config, getBase58Decoder().decode(new Uint8Array(32)), USER)).toBe(
            `Config.attestor is ${OTHER}, not this service's key ${USER}: set ATTESTOR_KEYPAIR to the key update_config named`,
        );
        expect(deploymentMismatch(config, getBase58Decoder().decode(new Uint8Array(32)), OTHER)).toBeNull();
    });
});

describe('the priority fee', () => {
    const rpc = (fees: number[]) =>
        ({
            getRecentPrioritizationFees: () => ({
                send: async () =>
                    fees.map((prioritizationFee, slot) => ({
                        prioritizationFee: BigInt(prioritizationFee),
                        slot: BigInt(slot),
                    })),
            }),
        }) as never;

    it("takes the recent fees' 75th percentile, within the floor and the ceiling", async () => {
        expect(await recentPriorityFee(rpc([...Array(100).fill(0), ...Array(50).fill(5_000)]), [])).toBe(5_000n);
        expect(await recentPriorityFee(rpc([...Array(120).fill(0), ...Array(30).fill(5_000)]), [])).toBe(1_000n);
        expect(await recentPriorityFee(rpc([]), [])).toBe(1_000n);
        expect(await recentPriorityFee(rpc([10_000_000_000]), [])).toBe(1_000_000n);
    });
});
