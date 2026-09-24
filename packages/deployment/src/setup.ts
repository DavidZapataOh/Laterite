import {
    type Config,
    type ConfigParamsArgs,
    fetchMaybeConfig,
    findConfigPda,
    findPlanAddress,
    findSwapAuthorityPda,
    findVaultPda,
    getConfigParamsEncoder,
    getCreatePlanInstruction,
    getInitializeInstructionAsync,
    getOnboardingLookupTableAddresses,
    getSetMarketCalendarInstruction,
    getSettingsEncoder,
    getUpdateConfigInstruction,
    PLAN_PERIOD_HOURS,
    planId,
    TIERS,
} from '@laterite/client';
import {
    AccountRole,
    type Address,
    createNoopSigner,
    fetchEncodedAccounts,
    type GetAccountInfoApi,
    type GetBalanceApi,
    getBase64Decoder,
    type GetMultipleAccountsApi,
    type GetSlotApi,
    type Instruction,
    isNone,
    type ReadonlyUint8Array,
    type Rpc,
    type Signature,
    type TransactionSigner,
} from '@solana/kit';
import { decodePlan, SUBSCRIPTIONS_PROGRAM_ADDRESS } from '@solana/subscriptions';
import { fetchSysvarClock } from '@solana/sysvars';
import {
    fetchMaybeAddressLookupTable,
    findAddressLookupTablePda,
    getCreateLookupTableInstruction,
    getExtendLookupTableInstruction,
    getFreezeLookupTableInstruction,
} from '@solana-program/address-lookup-table';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';

import { isMarketCalendarLoaded, marketCalendarArgs, type MarketCalendarDays } from './calendar';

/** The cluster a deployment reads and writes: an RPC and a confirmed `send`. */
export type Cluster = {
    rpc: Rpc<GetAccountInfoApi & GetBalanceApi & GetMultipleAccountsApi & GetSlotApi>;
    send(feePayer: TransactionSigner, instructions: Instruction[]): Promise<Signature>;
};

/** What a deployment leaves on the cluster besides the program and its config. */
export type Deployment = {
    config: Config;
    /** The onboarding lookup table (ADR-003), frozen; known before the transaction that creates it is sent. */
    lookupTable?: Address;
    /** The transaction whose `MarketCalendarSet` loaded the calendar the config holds. */
    marketCalendarSet?: Signature;
    /** The swap authority's account in each payment token, in table order, then in each of the router's mints. */
    swapAccounts: Address[];
};

/** A mint and the token program that owns it. */
export type TokenMint = { mint: Address; tokenProgram: Address };

/** The settings keys only a deliberate rotation changes. */
export type SettingsKey = 'attestor' | 'sponsor';

/** Thrown when the config holds another attestor or sponsor than the deployment's: only a rotation changes them. */
export class KeyRotationRequiredError extends Error {
    constructor(
        readonly role: SettingsKey,
        readonly stored: Address,
        readonly expected: Address,
    ) {
        super(`The config's ${role} is ${stored}, not ${expected}: change it only by rotating the ${role}`);
        this.name = 'KeyRotationRequiredError';
    }
}

/**
 * Thrown when an admin instruction is needed but `Config.admin` is no longer the local key (handed over, for example
 * to a Squads vault): the message carries the instruction for the admin to propose and sign.
 */
export class AdminHandedOverError extends Error {
    readonly instruction: Instruction;

    constructor(
        readonly admin: Address,
        built: Instruction,
    ) {
        const instruction = {
            ...built,
            accounts: (built.accounts ?? []).map(({ address, role }) => ({ address, role })),
        };
        const accounts = instruction.accounts.map(({ address, role }) => ({
            address,
            signer: role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER,
            writable: role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER,
        }));
        const data = getBase64Decoder().decode(instruction.data ?? new Uint8Array());
        super(
            `The admin is ${admin}, not the local key: propose this instruction from the admin ` +
                `(a Squads transaction for a vault): ${JSON.stringify({ accounts, data, programAddress: instruction.programAddress })}`,
        );
        this.name = 'AdminHandedOverError';
        this.instruction = instruction;
    }
}

/** Sends an admin instruction signed by `admin`, or throws it for the current admin when that is another key. */
async function sendAsAdmin(
    cluster: Cluster,
    config: Config,
    admin: TransactionSigner,
    build: (signer: TransactionSigner) => Instruction,
) {
    if (config.admin !== admin.address)
        throw new AdminHandedOverError(config.admin, build(createNoopSigner(config.admin)));
    return await cluster.send(admin, [build(admin)]);
}

const equal = (a: ReadonlyUint8Array, b: ReadonlyUint8Array) =>
    a.length === b.length && a.every((byte, index) => byte === b[index]);

async function fetchConfig(cluster: Cluster): Promise<Config | null> {
    const account = await fetchMaybeConfig(cluster.rpc, (await findConfigPda())[0]);
    return account.exists ? account.data : null;
}

/**
 * Initializes the config as the program's upgrade authority, which becomes its admin, unless it exists. The tables,
 * the router and the genesis hash are fixed at `initialize`, so an existing config with others is refused (a new
 * deployment needs a new program. Another attestor or sponsor is refused too ({@link KeyRotationRequiredError}); changed
 * caps are brought to `params` with `update_config`.
 */
export async function ensureConfig(
    cluster: Cluster,
    authority: TransactionSigner,
    params: ConfigParamsArgs,
): Promise<Config> {
    let config = await fetchConfig(cluster);
    if (!config) {
        const initialize = await getInitializeInstructionAsync({ authority, params });
        const mints = [...params.assets, ...params.paymentTokens].map(({ mint }) => ({
            address: mint,
            role: AccountRole.READONLY,
        }));
        await cluster.send(authority, [{ ...initialize, accounts: [...initialize.accounts, ...mints] }]);
        config = (await fetchConfig(cluster))!;
    }
    // The settings are compared apart: they are the only fields `update_config` can change.
    const fixed = (source: Omit<ConfigParamsArgs, 'settings'>) =>
        getConfigParamsEncoder().encode({ ...source, settings: params.settings });
    if (!equal(fixed(config), fixed(params))) {
        throw new Error(
            `The config holds another router, asset or payment-token table or genesis hash, all fixed at initialize; ` +
                `deploying other ones takes a new program`,
        );
    }
    for (const role of ['attestor', 'sponsor'] as const) {
        if (config[role] !== params.settings[role]) {
            throw new KeyRotationRequiredError(role, config[role], params.settings[role]);
        }
    }
    if (!equal(getSettingsEncoder().encode(config), getSettingsEncoder().encode(params.settings))) {
        await sendAsAdmin(cluster, config, authority, admin =>
            getUpdateConfigInstruction({ admin, settings: params.settings }),
        );
        config = (await fetchConfig(cluster))!;
    }
    return config;
}

/** Replaces the config's attestor or sponsor with `key` (`update_config`, the other settings unchanged). */
export async function rotateSettingsKey(
    cluster: Cluster,
    admin: TransactionSigner,
    config: Config,
    role: SettingsKey,
    key: Address,
): Promise<Signature> {
    const settings = {
        attestor: config.attestor,
        maxUsers: config.maxUsers,
        sponsor: config.sponsor,
        userWeeklyCap: config.userWeeklyCap,
        [role]: key,
    };
    return await sendAsAdmin(cluster, config, admin, signer => getUpdateConfigInstruction({ admin: signer, settings }));
}

/**
 * Loads `calendar` with `set_market_calendar` unless the config already holds it; returns the transaction's signature,
 * or `null` when nothing was sent.
 */
export async function ensureMarketCalendar(
    cluster: Cluster,
    admin: TransactionSigner,
    config: Config,
    calendar: MarketCalendarDays,
): Promise<Signature | null> {
    if (isMarketCalendarLoaded(config.marketCalendar, calendar)) return null;
    const { unixTimestamp } = await fetchSysvarClock(cluster.rpc);
    const { earlyCloses, holidays, validThrough } = marketCalendarArgs(calendar, Number(unixTimestamp / 86_400n));
    return await sendAsAdmin(cluster, config, admin, signer =>
        getSetMarketCalendarInstruction({ admin: signer, earlyCloses, holidays, validThrough }),
    );
}

/**
 * Creates the four plans (each payment token at each tier), all in one transaction, unless they exist; an existing
 * plan must have the terms `create_plan` sets: the vault as owner, the table's mint, the tier's amount per week and
 * the swap authority as its only destination.
 */
export async function ensurePlans(cluster: Cluster, admin: TransactionSigner, config: Config): Promise<void> {
    const [[vault], [swapAuthority]] = await Promise.all([findVaultPda(), findSwapAuthorityPda()]);
    const plans = await Promise.all(
        config.paymentTokens.flatMap((token, paymentToken) =>
            TIERS.map(async (amount, tier) => ({
                address: await findPlanAddress(paymentToken, tier),
                amount,
                paymentToken,
                tier,
                token,
            })),
        ),
    );
    const accounts = await fetchEncodedAccounts(
        cluster.rpc,
        plans.map(plan => plan.address),
    );
    const missing = [];
    for (const [index, plan] of plans.entries()) {
        const account = accounts[index]!;
        if (!account.exists) {
            missing.push(plan);
            continue;
        }
        const { data, owner } = decodePlan(account).data;
        const terms =
            account.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS &&
            owner === vault &&
            data.planId === planId(plan.paymentToken, plan.tier) &&
            data.mint === plan.token.mint &&
            data.terms.amount === plan.amount &&
            data.terms.periodHours === PLAN_PERIOD_HOURS &&
            data.destinations.length === 4 &&
            data.destinations[0] === swapAuthority &&
            data.destinations.slice(1).every(destination => destination === SYSTEM_PROGRAM_ADDRESS);
        if (!terms) throw new Error(`Plan ${plan.address} exists with other terms than create_plan sets`);
    }
    if (missing.length === 0) return;
    if (config.admin !== admin.address) {
        const [plan] = missing;
        throw new AdminHandedOverError(
            config.admin,
            getCreatePlanInstruction({
                admin: createNoopSigner(config.admin),
                mint: plan!.token.mint,
                paymentToken: plan!.paymentToken,
                plan: plan!.address,
                tier: plan!.tier,
                tokenProgram: plan!.token.tokenProgram,
            }),
        );
    }
    await cluster.send(
        admin,
        missing.map(plan =>
            getCreatePlanInstruction({
                admin,
                mint: plan.token.mint,
                paymentToken: plan.paymentToken,
                plan: plan.address,
                tier: plan.tier,
                tokenProgram: plan.token.tokenProgram,
            }),
        ),
    );
}

/**
 * Creates the swap authority's account in each payment token, which the plans pay into and the route spends from,
 * and in each of `routeMints`, the other mints the router's routes pass through the taker's own accounts, all in one
 * transaction, unless they exist; returns them in that order.
 */
export async function ensureSwapAuthorityAccounts(
    cluster: Cluster,
    payer: TransactionSigner,
    config: Config,
    routeMints: readonly TokenMint[] = [],
): Promise<Address[]> {
    const [swapAuthority] = await findSwapAuthorityPda();
    const mints = [...config.paymentTokens, ...routeMints];
    const accounts = await Promise.all(
        mints.map(
            async ({ mint, tokenProgram }) =>
                (await findAssociatedTokenPda({ mint, owner: swapAuthority, tokenProgram }))[0],
        ),
    );
    const existing = await fetchEncodedAccounts(cluster.rpc, accounts);
    const missing = mints.filter((_, index) => !existing[index]!.exists);
    if (missing.length > 0) {
        await cluster.send(
            payer,
            await Promise.all(
                missing.map(({ mint, tokenProgram }) =>
                    getCreateAssociatedTokenIdempotentInstructionAsync({
                        mint,
                        owner: swapAuthority,
                        payer,
                        tokenProgram,
                    }),
                ),
            ),
        );
    }
    return accounts;
}

/**
 * The onboarding lookup table (ADR-003): `existing` when it holds exactly the onboarding addresses and is frozen,
 * else a new table created, extended and frozen by `authority` in one transaction, so no key can change the
 * addresses every sponsored transaction resolves through it. `record` receives a new table's address before that
 * transaction is sent, so an interrupted run leaves no table unrecorded.
 */
export async function ensureOnboardingLookupTable(
    cluster: Cluster,
    authority: TransactionSigner,
    config: Config,
    existing?: Address,
    record: (table: Address) => Promise<void> = async () => {},
): Promise<Address> {
    const addresses = await getOnboardingLookupTableAddresses(config);
    if (existing) {
        const table = await fetchMaybeAddressLookupTable(cluster.rpc, existing);
        if (table.exists) {
            const same =
                table.data.addresses.length === addresses.length &&
                table.data.addresses.every((address, index) => address === addresses[index]);
            if (same && isNone(table.data.authority)) return existing;
            throw new Error(`Lookup table ${existing} does not hold exactly the onboarding addresses, frozen`);
        }
    }
    const recentSlot = await cluster.rpc.getSlot({ commitment: 'finalized' }).send();
    const [table, bump] = await findAddressLookupTablePda({ authority: authority.address, recentSlot });
    await record(table);
    await cluster.send(authority, [
        getCreateLookupTableInstruction({ address: [table, bump], authority, payer: authority, recentSlot }),
        getExtendLookupTableInstruction({ address: table, addresses, authority, payer: authority }),
        getFreezeLookupTableInstruction({ address: table, authority }),
    ]);
    return table;
}

/**
 * Brings a cluster's deployment of the program to `params`: the config (initialized as the upgrade authority), the
 * four plans, the swap authority's accounts (the payment tokens' and `routeMints`', which a router such as Jupiter
 * needs), the market calendar and the onboarding lookup table. `recorded` is what
 * an earlier run recorded; `record` receives the deployment whenever that changes (the calendar's signature once it
 * is loaded, a new table's address before it is created). Each step sends only what is missing, so a second run
 * sends nothing.
 */
export async function ensureDeployment(
    cluster: Cluster,
    input: {
        authority: TransactionSigner;
        calendar: MarketCalendarDays;
        params: ConfigParamsArgs;
        record?: (deployment: Deployment) => Promise<void>;
        recorded?: Pick<Deployment, 'lookupTable' | 'marketCalendarSet'>;
        routeMints?: readonly TokenMint[];
    },
): Promise<Deployment> {
    const { authority, calendar, params } = input;
    const record = input.record ?? (async () => {});
    const config = await ensureConfig(cluster, authority, params);
    await ensurePlans(cluster, authority, config);
    const deployment: Deployment = {
        config,
        lookupTable: input.recorded?.lookupTable,
        marketCalendarSet: input.recorded?.marketCalendarSet,
        swapAccounts: await ensureSwapAuthorityAccounts(cluster, authority, config, input.routeMints),
    };
    const marketCalendarSet = await ensureMarketCalendar(cluster, authority, config, calendar);
    if (marketCalendarSet) {
        Object.assign(deployment, { config: (await fetchConfig(cluster))!, marketCalendarSet });
        await record(deployment);
    }
    deployment.lookupTable = await ensureOnboardingLookupTable(
        cluster,
        authority,
        config,
        deployment.lookupTable,
        async lookupTable => {
            deployment.lookupTable = lookupTable;
            await record(deployment);
        },
    );
    return deployment;
}
