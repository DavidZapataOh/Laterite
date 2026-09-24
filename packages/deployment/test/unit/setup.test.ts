import {
    type ConfigParamsArgs,
    fetchConfig,
    findConfigPda,
    findPlanAddress,
    findSwapAuthorityPda,
    findVaultPda,
    getAcceptAdminInstruction,
    getConfigParamsEncoder,
    getOnboardingLookupTableAddresses,
    getProposeAdminInstruction,
    PLAN_PERIOD_HOURS,
    TIERS,
} from '@laterite/client';
import { addresses as devnet } from '@laterite/devnet/addresses';
import {
    type Address,
    addSignersToInstruction,
    generateKeyPairSigner,
    getBase58Encoder,
    isNone,
    lamports,
} from '@solana/kit';
import { fetchPlan, getPlanDecoder, getPlanEncoder, SUBSCRIPTIONS_PROGRAM_ADDRESS } from '@solana/subscriptions';
import {
    fetchAddressLookupTable,
    findAddressLookupTablePda,
    getCreateLookupTableInstruction,
    getExtendLookupTableInstruction,
} from '@solana-program/address-lookup-table';
import { fetchToken, findAssociatedTokenPda } from '@solana-program/token';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    AdminHandedOverError,
    type Deployment,
    devnetConfigParams,
    ensureConfig,
    ensureDeployment,
    ensureMarketCalendar,
    ensureOnboardingLookupTable,
    ensurePlans,
    isMarketCalendarLoaded,
    KeyRotationRequiredError,
    MARKET_CALENDAR_FILE,
    type MarketCalendarDays,
    readMarketCalendar,
    rotateSettingsKey,
} from '../../src';
import { TestCluster } from './env';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DAY_2026_09_21 = 20_717n;

let cluster: TestCluster;
let params: ConfigParamsArgs;
let calendar: MarketCalendarDays;

beforeEach(async () => {
    cluster = await TestCluster.create();
    cluster.setDay(DAY_2026_09_21);
    params = devnetConfigParams({
        attestor: (await generateKeyPairSigner()).address,
        genesisHash: DEVNET_GENESIS_HASH,
        sponsor: (await generateKeyPairSigner()).address,
    });
    calendar = await readMarketCalendar(MARKET_CALENDAR_FILE);
    records = [];
});

/** Every deployment `ensureDeployment` recorded, with the lookup table's existence when it was recorded. */
let records: { deployment: Deployment; tableExists: boolean }[];

const deploy = (recorded?: Pick<Deployment, 'lookupTable' | 'marketCalendarSet'>) =>
    ensureDeployment(cluster, {
        authority: cluster.authority,
        calendar,
        params,
        record: async deployment => {
            const tableExists = !!deployment.lookupTable && cluster.svm.getAccount(deployment.lookupTable).exists;
            records.push({ deployment: { ...deployment }, tableExists });
        },
        recorded,
    });

describe('devnet configuration', () => {
    it('is built from the devnet addresses, the keys and the genesis hash', () => {
        expect(params.router).toBe(devnet.cpmm.program);
        expect(params.assets.map(asset => asset.mint)).toEqual([devnet.tokens.SPYx.mint, devnet.tokens.QQQx.mint]);
        expect(params.assets.map(asset => asset.pythFeedId)).toEqual([1843, 1837]);
        expect(params.paymentTokens.map(token => token.mint)).toEqual([
            devnet.tokens.USDC.mint,
            devnet.tokens.USDT.mint,
        ]);
        expect(params.paymentTokens.map(token => token.usdFeedId)).toEqual([0, 8]);
        expect(params.paymentTokens.every(token => token.decimals === 6)).toBe(true);
        expect(params.genesisHash).toEqual(getBase58Encoder().encode(DEVNET_GENESIS_HASH));
        expect(params.settings.userWeeklyCap).toBe(TIERS[1]);
    });
});

describe('ensureDeployment', () => {
    it('takes an empty program to a full deployment, and a second run sends nothing', async () => {
        const deployment = await deploy();
        expect(cluster.sent).toBe(5);

        const config = await fetchConfig(cluster.rpc, (await findConfigPda())[0]);
        const stored: ConfigParamsArgs = {
            assets: config.data.assets,
            genesisHash: config.data.genesisHash,
            paymentTokens: config.data.paymentTokens,
            router: config.data.router,
            settings: config.data,
        };
        expect(getConfigParamsEncoder().encode(stored)).toEqual(getConfigParamsEncoder().encode(params));
        expect(config.data.admin).toBe(cluster.authority.address);
        expect(isMarketCalendarLoaded(config.data.marketCalendar, calendar)).toBe(true);
        expect(config.data.marketCalendar.firstDay).toBe(Number(DAY_2026_09_21));

        const [[vault], [swapAuthority]] = await Promise.all([findVaultPda(), findSwapAuthorityPda()]);
        for (const [paymentToken, token] of params.paymentTokens.entries()) {
            for (const tier of [0, 1]) {
                const plan = await fetchPlan(cluster.rpc, await findPlanAddress(paymentToken, tier));
                expect(plan.data.owner).toBe(vault);
                expect(plan.data.data.mint).toBe(token.mint);
                expect(plan.data.data.terms.amount).toBe(TIERS[tier]);
                expect(plan.data.data.terms.periodHours).toBe(PLAN_PERIOD_HOURS);
                expect(plan.data.data.destinations[0]).toBe(swapAuthority);
            }
            const account = deployment.swapAccounts[paymentToken]!;
            const [expected] = await findAssociatedTokenPda({
                mint: token.mint,
                owner: swapAuthority,
                tokenProgram: token.tokenProgram,
            });
            expect(account).toBe(expected);
            const { data } = await fetchToken(cluster.rpc, account);
            expect([data.owner, data.mint, data.amount]).toEqual([swapAuthority, token.mint, 0n]);
        }

        const table = await fetchAddressLookupTable(cluster.rpc, deployment.lookupTable!);
        expect(table.data.addresses).toEqual(await getOnboardingLookupTableAddresses(config.data));
        expect(isNone(table.data.authority)).toBe(true);

        expect(await deploy(deployment)).toEqual(deployment);
        expect(cluster.sent).toBe(5);
    });

    it('records the calendar signature once loaded and the table before creating it', async () => {
        const deployment = await deploy();
        expect(
            records.map(({ deployment, tableExists }) => [
                deployment.marketCalendarSet,
                deployment.lookupTable,
                tableExists,
            ]),
        ).toEqual([
            [deployment.marketCalendarSet, undefined, false],
            [deployment.marketCalendarSet, deployment.lookupTable, false],
        ]);
        const transaction = cluster.svm.getTransaction(deployment.marketCalendarSet!);
        expect(transaction).not.toBeNull();
        await deploy(deployment);
        expect(records).toHaveLength(2);
    });

    it('creates a new table when the recorded one was never created', async () => {
        const first = await deploy();
        const orphan = (await generateKeyPairSigner()).address;
        const deployment = await deploy({ ...first, lookupTable: orphan });
        expect(deployment.lookupTable).not.toBe(orphan);
        expect(records.at(-1)!.deployment.lookupTable).toBe(deployment.lookupTable);
    });

    it('refuses a config initialized with another router or genesis hash', async () => {
        await ensureConfig(cluster, cluster.authority, params);
        await expect(
            ensureConfig(cluster, cluster.authority, { ...params, router: SUBSCRIPTIONS_PROGRAM_ADDRESS }),
        ).rejects.toThrow('fixed at initialize');
        const mainnet = getBase58Encoder().encode('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
        await expect(ensureConfig(cluster, cluster.authority, { ...params, genesisHash: mainnet })).rejects.toThrow(
            'fixed at initialize',
        );
    });

    it('updates changed caps', async () => {
        await ensureConfig(cluster, cluster.authority, params);
        const config = await ensureConfig(cluster, cluster.authority, {
            ...params,
            settings: { ...params.settings, maxUsers: 5, userWeeklyCap: 10_000_000n },
        });
        expect([config.maxUsers, config.userWeeklyCap]).toEqual([5, 10_000_000n]);
        expect(cluster.sent).toBe(2);
    });

    it('changes the attestor or the sponsor only through a rotation', async () => {
        const config = await ensureConfig(cluster, cluster.authority, params);
        for (const role of ['attestor', 'sponsor'] as const) {
            const key = (await generateKeyPairSigner()).address;
            const error = await ensureConfig(cluster, cluster.authority, {
                ...params,
                settings: { ...params.settings, [role]: key },
            }).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(KeyRotationRequiredError);
            expect(error).toMatchObject({ expected: key, role, stored: config[role] });
        }
        expect(cluster.sent).toBe(1);
        const sponsor = (await generateKeyPairSigner()).address;
        await rotateSettingsKey(cluster, cluster.authority, config, 'sponsor', sponsor);
        const rotated = await ensureConfig(cluster, cluster.authority, {
            ...params,
            settings: { ...params.settings, sponsor },
        });
        expect([rotated.sponsor, rotated.attestor, rotated.maxUsers]).toEqual([
            sponsor,
            config.attestor,
            config.maxUsers,
        ]);
        expect(cluster.sent).toBe(2);
    });

    it('reloads the calendar only when the file changes', async () => {
        const config = await ensureConfig(cluster, cluster.authority, params);
        expect(await ensureMarketCalendar(cluster, cluster.authority, config, calendar)).not.toBeNull();
        cluster.setDay(DAY_2026_09_21 + 30n);
        const loaded = await fetchConfig(cluster.rpc, (await findConfigPda())[0]);
        expect(await ensureMarketCalendar(cluster, cluster.authority, loaded.data, calendar)).toBeNull();

        const closure = { ...calendar, holidays: [...calendar.holidays, 21_547].sort((a, b) => a - b) };
        expect(await ensureMarketCalendar(cluster, cluster.authority, loaded.data, closure)).not.toBeNull();
        const reloaded = await fetchConfig(cluster.rpc, (await findConfigPda())[0]);
        expect(reloaded.data.marketCalendar.firstDay).toBe(Number(DAY_2026_09_21 + 30n));
        expect(isMarketCalendarLoaded(reloaded.data.marketCalendar, closure)).toBe(true);
        expect(cluster.sent).toBe(3);
    });

    it('loads the file more than a year after its first closure, which the program would refuse', async () => {
        const config = await ensureConfig(cluster, cluster.authority, params);
        cluster.setDay(DAY_2026_09_21 + 400n);
        expect(await ensureMarketCalendar(cluster, cluster.authority, config, calendar)).not.toBeNull();
        const loaded = await fetchConfig(cluster.rpc, (await findConfigPda())[0]);
        expect(isMarketCalendarLoaded(loaded.data.marketCalendar, calendar)).toBe(true);
    });

    it('refuses an existing plan with other terms', async () => {
        const config = await ensureConfig(cluster, cluster.authority, params);
        await ensurePlans(cluster, cluster.authority, config);
        const address = await findPlanAddress(1, 1);
        const plan = getPlanDecoder().decode(cluster.data(address));
        cluster.write(
            address,
            new Uint8Array(
                getPlanEncoder().encode({ ...plan, data: { ...plan.data, terms: { ...plan.data.terms, amount: 1n } } }),
            ),
            SUBSCRIPTIONS_PROGRAM_ADDRESS,
        );
        await expect(ensurePlans(cluster, cluster.authority, config)).rejects.toThrow(`Plan ${address}`);

        const destinations = [...plan.data.destinations];
        destinations[1] = cluster.authority.address;
        cluster.write(
            address,
            new Uint8Array(getPlanEncoder().encode({ ...plan, data: { ...plan.data, destinations } })),
            SUBSCRIPTIONS_PROGRAM_ADDRESS,
        );
        await expect(ensurePlans(cluster, cluster.authority, config)).rejects.toThrow(`Plan ${address}`);
    });

    it('refuses a lookup table with other addresses', async () => {
        const config = await ensureConfig(cluster, cluster.authority, params);
        const recentSlot = cluster.svm.getClock().slot - 1n;
        const [table, bump] = await findAddressLookupTablePda({ authority: cluster.authority.address, recentSlot });
        await cluster.send(cluster.authority, [
            getCreateLookupTableInstruction({
                address: [table, bump],
                authority: cluster.authority,
                payer: cluster.authority,
                recentSlot,
            }),
            getExtendLookupTableInstruction({
                address: table,
                addresses: [devnet.cpmm.program],
                authority: cluster.authority,
                payer: cluster.authority,
            }),
        ]);
        await expect(ensureOnboardingLookupTable(cluster, cluster.authority, config, table)).rejects.toThrow(
            `Lookup table ${table}`,
        );
    });

    it('hands an admin instruction to the new admin once the admin has changed', async () => {
        const config = await ensureConfig(cluster, cluster.authority, params);
        const vault = await generateKeyPairSigner();
        cluster.svm.airdrop(vault.address, lamports(1_000_000_000n));
        await cluster.send(cluster.authority, [
            getProposeAdminInstruction({ admin: cluster.authority, newAdmin: vault.address }),
        ]);
        await cluster.send(vault, [getAcceptAdminInstruction({ pendingAdmin: vault })]);
        const handedOver = await fetchConfig(cluster.rpc, (await findConfigPda())[0]);
        const error = await ensureMarketCalendar(cluster, cluster.authority, handedOver.data, calendar).catch(
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(AdminHandedOverError);
        const { instruction } = error as AdminHandedOverError;
        expect(instruction.accounts?.[0]).toMatchObject({ address: vault.address });
        await cluster.send(vault, [addSignersToInstruction([vault], instruction)]);
        const loaded = await fetchConfig(cluster.rpc, (await findConfigPda())[0]);
        expect(isMarketCalendarLoaded(loaded.data.marketCalendar, calendar)).toBe(true);
    });
});
