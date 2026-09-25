import { expect, type Page, test } from '@playwright/test';

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
    {
        act: async (page, spanish) => {
            await connected(/\$25/)(page, spanish);
            await page.getByRole('button', { name: /^(Wallet|Billetera) / }).click();
        },
        name: 'wallet-menu',
        wallets: [{ key: users.active, name: 'Phantom' }],
    },
];

const readClosedChain = (page: Page) =>
    page.route(`http://127.0.0.1:${RPC_PORT}/**`, async route =>
        route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${CLOSED_RPC_PORT}/` }) }),
    );

for (const { name, wallets = [], headers = {}, act, closed } of states) {
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
                await installWallets(page, wallets);
                await page.goto(locale === 'en' ? '/' : '/es');
                await page.evaluate(() => document.fonts.ready);
                await act?.(page, locale === 'es');
                await page.waitForTimeout(250);
                await page.screenshot({ fullPage: true, path: `${dir}/${name}-${width}-${locale}.png` });
                await context.close();
            });
        }
    }
}

/** The comp's own frame: a 390px phone at the comp's 1024 × 1536 pixels. */
const beside = states.filter(({ name }) => ['welcome', 'frame-active', 'onboarding'].includes(name));
for (const { name, wallets = [], act } of beside) {
    test(`${name} beside the comp`, async ({ browser }) => {
        const context = await browser.newContext({
            deviceScaleFactor: 1024 / 390,
            reducedMotion: 'reduce',
            viewport: { height: 585, width: 390 },
        });
        const page = await context.newPage();
        await installWallets(page, wallets);
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
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${dir}/comp-${name}.png` });
        await context.close();
    });
}
