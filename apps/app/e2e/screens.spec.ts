import { expect, type Page, test } from '@playwright/test';

import { testKey, users } from './support/keys';
import { installWallets, type TestWallet } from './support/wallets';

/** Captures every state of the screen at both widths in both locales into SCREENS_DIR; skipped without it. */
const dir = process.env.SCREENS_DIR;
test.skip(!dir, 'set SCREENS_DIR to capture the screens');

type State = {
    name: string;
    wallets?: TestWallet[];
    headers?: Record<string, string>;
    act?: (page: Page, spanish: boolean) => Promise<void>;
};

const connect = (label: RegExp) => async (page: Page) => {
    await page.getByRole('button', { name: label }).click();
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
    { act: connected(/\$0/), name: 'not-enrolled', wallets: [{ key: users.newcomer, name: 'Phantom' }] },
    { act: connected(/\$25/), name: 'frame-active', wallets: [{ key: users.active, name: 'Phantom' }] },
    { act: connected(/\$10/), name: 'frame-paused', wallets: [{ key: users.paused, name: 'Solflare' }] },
    { act: connected(/\$0/), name: 'exited', wallets: [{ key: users.exited, name: 'Backpack' }] },
    {
        act: async (page, spanish) => {
            await connected(/\$25/)(page, spanish);
            await page.getByRole('button', { name: /^(Wallet|Billetera) / }).click();
        },
        name: 'wallet-menu',
        wallets: [{ key: users.active, name: 'Phantom' }],
    },
];

for (const { name, wallets = [], headers = {}, act } of states) {
    for (const width of [390, 1440]) {
        for (const locale of ['en', 'es']) {
            test(`${name} ${width} ${locale}`, async ({ browser }) => {
                const context = await browser.newContext({
                    extraHTTPHeaders: headers,
                    reducedMotion: 'reduce',
                    viewport: { height: width === 390 ? 844 : 900, width },
                });
                const page = await context.newPage();
                await installWallets(page, wallets);
                await page.goto(locale === 'en' ? '/' : '/es');
                await page.evaluate(() => document.fonts.ready);
                await act?.(page, locale === 'es');
                await page.waitForTimeout(250);
                await page.screenshot({ path: `${dir}/${name}-${width}-${locale}.png` });
                await context.close();
            });
        }
    }
}

/** The comp's own frame: a 390px phone at the comp's 1024 × 1536 pixels. */
for (const { name, wallets = [], act } of states.filter(({ name }) => ['welcome', 'frame-active'].includes(name))) {
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
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${dir}/comp-${name}.png` });
        await context.close();
    });
}
