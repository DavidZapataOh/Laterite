import { expect, type Page, test } from '@playwright/test';

import { declare } from './support/declarations';
import { testKey, users } from './support/keys';
import { CLOSED_RPC_PORT, RPC_PORT } from './support/validator';
import { installWallets, type TestWallet } from './support/wallets';

/** Captures every state of the screen at both widths in both locales into SCREENS_DIR; skipped without it. */
const dir = process.env.SCREENS_DIR;
test.skip(!dir, 'set SCREENS_DIR to capture the screens');

type State = {
    name: string;
    /** Read the chain whose `Config` has the kill switch set. */
    closed?: boolean;
    wallets?: TestWallet[];
    /**
     * A new Phantom wallet with these options, declared and funded by the faucet: the sponsor's limits count each
     * wallet's builds, so states that build or sign never share one.
     */
    newcomer?: Partial<TestWallet>;
    headers?: Record<string, string>;
    act?: (page: Page, spanish: boolean) => Promise<void>;
};

const connect = (label: RegExp) => async (page: Page) => {
    await page.getByRole('button', { name: label }).click();
};
/** Connects and waits for onboarding's preview (or its closed state), then runs `then`. */
const onboarding = (then?: (page: Page, spanish: boolean) => Promise<void>) => async (page: Page, spanish: boolean) => {
    await page.getByRole('button', { name: spanish ? /^Conectar/ : /^Connect/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Si cobrás|If you get paid|Altas|Enrollment/);
    await then?.(page, spanish);
};
/** Connects, presses "Review and sign" and waits for the permission's test result (or refusal), then runs `then`. */
const permission =
    (then?: (page: Page, spanish: boolean) => Promise<void>, settled = true) =>
    async (page: Page, spanish: boolean) => {
        await page.getByRole('button', { name: spanish ? /^Conectar/ : /^Connect/ }).click();
        await page.getByRole('button', { name: spanish ? 'Revisar y firmar' : 'Review and sign' }).click();
        await expect(page.getByRole('heading', { level: 1 })).toContainText(/One permission|Un permiso/);
        if (settled)
            await expect(
                page.locator('#permission-status, [role="alert"]').filter({ hasText: /\S/ }).first(),
            ).toBeVisible();
        await then?.(page, spanish);
    };
const connected = (figure: RegExp) => async (page: Page, spanish: boolean) => {
    await page.getByRole('button', { name: spanish ? /^Conectar/ : /^Connect/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(figure);
};

const states: State[] = [
    { name: 'welcome' },
    { act: connect(/billetera|a wallet/), name: 'wallets-layer' },
    {
        act: async (page, spanish) => {
            await connect(/^Conectar|^Connect/)(page);
            await expect(page.getByText(spanish ? 'Aprobá en Phantom' : 'Approve in Phantom')).toBeVisible();
        },
        name: 'connecting',
        wallets: [{ holdConnect: true, key: users.active, name: 'Phantom' }],
    },
    {
        act: async page => {
            await connect(/^Conectar|^Connect/)(page);
            await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toBeVisible();
        },
        name: 'wallet-error',
        wallets: [{ key: users.active, name: 'Phantom', rejectConnect: true }],
    },
    { headers: { 'x-vercel-ip-country': 'US' }, name: 'blocked' },
    {
        act: async (page, spanish) => {
            await connect(/^Conectar|^Connect/)(page);
            await expect(
                page.getByRole('dialog', { name: spanish ? 'Antes de empezar' : 'Before you start' }),
            ).toBeVisible();
        },
        name: 'declaration',
        wallets: [{ key: testKey(`screens-${Date.now()}`), name: 'Phantom' }],
    },
    { act: onboarding(), name: 'onboarding', wallets: [{ key: users.holder, name: 'Phantom' }] },
    {
        act: onboarding(async (page, spanish) => {
            await page.getByRole('radio', { name: spanish ? 'Tengo ahorros' : 'I have savings' }).check();
            await page.getByRole('radio', { name: '2x' }).check();
        }),
        name: 'onboarding-savings',
        wallets: [{ key: users.holder, name: 'Phantom' }],
    },
    { act: onboarding(), name: 'onboarding-no-tokens', wallets: [{ key: users.newcomer, name: 'Phantom' }] },
    { act: onboarding(), name: 'onboarding-delegate', wallets: [{ key: users.delegated, name: 'Phantom' }] },
    {
        act: onboarding(async (page, spanish) => {
            await page.getByRole('textbox', { name: spanish ? 'Nombre de la meta' : 'Goal name' }).fill('x'.repeat(40));
        }),
        name: 'onboarding-problem',
        wallets: [{ key: users.holder, name: 'Phantom' }],
    },
    { act: connected(/\$25/), name: 'frame-active', wallets: [{ key: users.active, name: 'Phantom' }] },
    { act: connected(/\$10/), name: 'frame-paused', wallets: [{ key: users.paused, name: 'Solflare' }] },
    { act: onboarding(), name: 'onboarding-exited', wallets: [{ key: users.exited, name: 'Backpack' }] },
    { act: onboarding(), closed: true, name: 'onboarding-closed', wallets: [{ key: users.newcomer, name: 'Phantom' }] },
    { act: permission(), name: 'permission', newcomer: {} },
    {
        act: permission(async (page, spanish) => {
            await page.getByText(spanish ? /^¿Qué es SPYx\?/ : /^What is SPYx\?/).click();
        }),
        name: 'permission-what',
        newcomer: {},
    },
    {
        act: async (page, spanish) => {
            // the route's test never answers: the screen waits on it
            await page.route('**/api/sponsor/prepare', () => undefined);
            await permission(undefined, false)(page, spanish);
            await expect(page.locator('#permission-status')).toHaveText(/devnet/);
        },
        name: 'permission-checking',
        newcomer: {},
    },
    {
        act: permission(async (page, spanish) => {
            await page.getByRole('button', { name: spanish ? 'Firmar una vez' : 'Sign once' }).click();
            await expect(page.getByText(spanish ? 'Aprobá en Phantom' : 'Approve in Phantom')).toBeVisible();
        }),
        name: 'permission-signing',
        newcomer: { holdTransaction: true },
    },
    {
        act: permission(async (page, spanish) => {
            await page.getByRole('button', { name: spanish ? 'Firmar una vez' : 'Sign once' }).click();
            await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toBeVisible();
        }),
        name: 'permission-declined',
        newcomer: { rejectTransaction: true },
    },
    {
        act: async (page, spanish) => {
            await page.route('**/api/sponsor/prepare', route =>
                route.fulfill({ json: { code: 6010, error: 'simulation', program: 'laterite' }, status: 422 }),
            );
            await permission()(page, spanish);
        },
        name: 'permission-failed',
        newcomer: {},
    },
    { act: permission(), name: 'permission-returning', wallets: [{ key: users.returning, name: 'Backpack' }] },
    {
        act: permission(async page => {
            await page.keyboard.press('Tab');
            while (
                !(await page
                    .getByRole('button', { name: /^(Sign once|Firmar una vez)$/ })
                    .evaluate(b => b === document.activeElement))
            ) {
                await page.keyboard.press('Tab');
            }
        }),
        name: 'permission-focus',
        newcomer: {},
    },
    {
        // the Seal restamped: once the enrollment lands, the frame shows the permission Active
        act: async (page, spanish) => {
            await permission(async () => {
                await page.getByRole('button', { name: spanish ? 'Firmar una vez' : 'Sign once' }).click();
                await expect(page.getByRole('img', { name: spanish ? /^Activo/ : /^Active/ })).toBeVisible({
                    timeout: 60_000,
                });
            })(page, spanish);
        },
        name: 'permission-signed',
        newcomer: {},
    },
    {
        act: async (page, spanish) => {
            await connected(/\$25/)(page, spanish);
            await page.getByRole('button', { name: /^(Wallet|Billetera) / }).click();
        },
        name: 'wallet-menu',
        wallets: [{ key: users.active, name: 'Phantom' }],
    },
];

/** A state's wallets: its own, or a new one declared and given the faucet's test dollars. */
async function walletsOf(page: Page, state: Pick<State, 'newcomer' | 'wallets'>, tag: string): Promise<TestWallet[]> {
    if (!state.newcomer) return state.wallets ?? [];
    const key = testKey(`${tag}-${Date.now()}`);
    await declare([key]);
    expect((await page.request.post('/api/faucet', { data: { wallet: key.address } })).status()).toBe(201);
    return [{ key, name: 'Phantom', ...state.newcomer }];
}

const readClosedChain = (page: Page) =>
    page.route(`http://127.0.0.1:${RPC_PORT}/**`, async route =>
        route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${CLOSED_RPC_PORT}/` }) }),
    );

for (const { name, wallets: given = [], headers = {}, act, closed, newcomer } of states) {
    for (const width of [390, 1440]) {
        for (const locale of ['en', 'es']) {
            test(`${name} ${width} ${locale}`, async ({ browser }) => {
                const context = await browser.newContext({
                    extraHTTPHeaders: headers,
                    reducedMotion: 'reduce',
                    viewport: { height: width === 390 ? 844 : 900, width },
                });
                const page = await context.newPage();
                if (closed) await readClosedChain(page);
                await installWallets(
                    page,
                    await walletsOf(page, { newcomer, wallets: given }, `${name}-${width}-${locale}`),
                );
                await page.goto(locale === 'en' ? '/' : '/es');
                await page.evaluate(() => document.fonts.ready);
                await act?.(page, locale === 'es');
                // the resting state: no pointer over a control, every face drawn
                await page.mouse.move(0, 0);
                await page.evaluate(() => document.fonts.ready);
                await page.waitForTimeout(250);
                await page.screenshot({ fullPage: true, path: `${dir}/${name}-${width}-${locale}.png` });
                await context.close();
            });
        }
    }
}

/** The comp's own frame: a 390px phone at the comp's 1024 × 1536 pixels. */
const beside = states.filter(({ name }) => ['welcome', 'frame-active', 'onboarding', 'permission'].includes(name));
for (const { name, wallets = [], newcomer, act } of beside) {
    test(`${name} beside the comp`, async ({ browser }) => {
        const context = await browser.newContext({
            deviceScaleFactor: 1024 / 390,
            reducedMotion: 'reduce',
            viewport: { height: 585, width: 390 },
        });
        const page = await context.newPage();
        await installWallets(page, await walletsOf(page, { newcomer, wallets }, `comp-${name}`));
        await page.goto('/');
        await page.evaluate(() => document.fonts.ready);
        await act?.(page, false);
        if (name === 'onboarding') {
            // the comp's goal
            await page.getByRole('textbox', { name: 'Goal name' }).fill('House');
            await page.getByRole('textbox', { name: 'Goal amount' }).fill('5,000');
            await page.getByRole('textbox', { name: 'Goal amount' }).blur();
            await page.evaluate(() => window.scrollTo(0, 0));
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${dir}/comp-${name}.png` });
        await context.close();
    });
}
