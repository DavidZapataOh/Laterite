import { createSolanaRpc } from '@solana/kit';
import { expect, type Page, test } from '@playwright/test';

import { declare } from './support/declarations';
import { type TestKey, testKey, users } from './support/keys';
import { RPC_PORT } from './support/validator';
import { installWallets, type TestWallet } from './support/wallets';

const rpc = createSolanaRpc(`http://127.0.0.1:${RPC_PORT}`);
const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const signOnce = (page: Page) => page.getByRole('button', { name: 'Sign once' });
const clauses = (page: Page) => page.locator('main ol > li');
const notice = (page: Page) => page.getByRole('alert').filter({ hasText: /\S/ });
const tested = /^Tested on devnet: it goes through\. You pay 0 SOL, Laterite 0\.\d{4} SOL\.$/;

/** A new wallet that declared and holds $100 of test USDC and USDT from the app's own faucet. */
async function newcomer(page: Page, name: string): Promise<TestKey> {
    const key = testKey(`${name}-${Date.now()}`);
    await declare([key]);
    expect((await page.request.post('/api/faucet', { data: { wallet: key.address } })).status()).toBe(201);
    return key;
}

/** Connects `wallet`, waits for onboarding's rules and presses "Review and sign". */
async function review(page: Page, wallet: TestWallet, path = '/') {
    await installWallets(page, [wallet]);
    await page.goto(path);
    await page.getByRole('button', { name: /^(Connect|Conectar) / }).click();
    await page.getByRole('button', { name: /^(Review and sign|Revisar y firmar)$/ }).click();
}

test('a new wallet with no SOL reads what the permission does and enrolls with one signature', async ({ page }) => {
    const key = await newcomer(page, 'enroll');
    await review(page, { key, name: 'Phantom' });
    await expect(heading(page)).toHaveText('One permission$10/ wk max');
    await expect(page.locator('main p').first()).toHaveText('0 SOLLaterite pays fees');
    await expect(page.getByRole('img', { name: 'Unsigned: $10/WK' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'What the permission does' }).getByRole('listitem')).toHaveText([
        '01Spends at most $10 a week, in all.Laterite’s program holds your buys to $10 a week together, $5 in your first week. The Subscriptions program holds each of your USDC and USDT to $10 a week.',
        '02Only buys SPYx, into your own wallet.',
        '03Can’t send your dollars anywhere else.',
        '04Pause or exit whenever you want.',
        '05Each buy is priced by Pyth, on-chain.A buy must bring at least what fresh Pyth prices, verified on-chain at the careful end of their range, say it is worth, less 0.55%. USDT counts at its own Pyth price, USDC at $1.',
    ]);
    await page.getByText('What is SPYx? A token that tracks the S&P 500').click();
    await expect(
        page.getByText(/^An xStock: a token Backed Assets issues that tracks the SPDR S&P 500 ETF/),
    ).toBeVisible();
    // the route's test of the exact transaction shows before the wallet opens
    await expect(page.locator('#permission-status')).toHaveText(tested);
    await signOnce(page).click();
    await expect(heading(page)).toHaveText('Weekly cap$10/ wk', { timeout: 60_000 });
    await expect(page.getByRole('img', { name: 'Active: $10/WK' })).toBeVisible();
    expect((await rpc.getBalance(key.address, { commitment: 'confirmed' }).send()).value).toBe(0n);
});

test('an exited wallet comes back with one signature, and no new first week', async ({ page }) => {
    await review(page, { key: users.returning, name: 'Backpack' });
    await expect(heading(page)).toHaveText('One permission$10/ wk max');
    await expect(clauses(page).first()).toHaveText(
        '01Spends at most $10 a week, in all.Laterite’s program holds your buys to $10 a week together. The Subscriptions program holds your USDC to $10 a week.',
    );
    await expect(page.locator('#permission-status')).toHaveText(tested);
    await signOnce(page).click();
    await expect(heading(page)).toHaveText('Weekly cap$10/ wk', { timeout: 60_000 });
    await expect(page.getByRole('img', { name: 'Active: $10/WK' })).toBeVisible();
});

test('the way back keeps the rules as they were chosen', async ({ page }) => {
    await installWallets(page, [{ key: users.holder, name: 'Solflare' }]);
    await page.goto('/');
    await page.getByRole('button', { name: /^Connect / }).click();
    await page.getByRole('radio', { name: '$25' }).check();
    await page.getByRole('radio', { name: 'QQQx' }).check();
    await page.getByRole('checkbox', { name: 'USDT' }).uncheck();
    await page.getByRole('button', { name: 'Review and sign' }).click();
    await expect(heading(page)).toHaveText('One permission$25/ wk max');
    await expect(clauses(page).nth(1)).toHaveText('02Only buys QQQx, into your own wallet.');
    await expect(page.getByText('What is QQQx? A token that tracks the Nasdaq-100')).toBeVisible();
    await page.getByRole('button', { name: 'Your rules' }).click();
    await expect(page.getByRole('radio', { name: '$25' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'QQQx' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'USDT' })).not.toBeChecked();
});

for (const [wallet, says] of [
    [{ rejectTransaction: true }, 'You did not sign. Nothing was sent.'],
    [{ modifyTransaction: true }, 'Your wallet changed the transaction, so Laterite did not send it.'],
] as const) {
    test(`a wallet that ${'rejectTransaction' in wallet ? 'does not sign' : 'rewrites the transaction'} sends nothing`, async ({
        page,
    }) => {
        const key = await newcomer(page, 'rejectTransaction' in wallet ? 'declines' : 'rewrites');
        await review(page, { key, name: 'Phantom', ...wallet });
        await expect(page.locator('#permission-status')).toHaveText(tested);
        await signOnce(page).click();
        await expect(notice(page)).toHaveText(says);
        // signing again is the way on; nothing reached the chain but the faucet's grant
        await expect(signOnce(page)).toBeEnabled();
        expect(await rpc.getSignaturesForAddress(key.address).send()).toHaveLength(1);
    });
}

test('a refusal in the test run is said in plain words, and tested again on request', async ({ page }) => {
    await page.route('**/api/sponsor/prepare', route =>
        route.fulfill({ json: { code: 6010, error: 'simulation', program: 'laterite' }, status: 422 }),
    );
    await review(page, { key: users.holder, name: 'Phantom' });
    await expect(notice(page)).toContainText(
        'Devnet refused it in a test run (Laterite error 6010). Nothing was signed.',
    );
    await expect(signOnce(page)).toBeDisabled();
    await page.unroute('**/api/sponsor/prepare');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('#permission-status')).toHaveText(tested);
    await expect(signOnce(page)).toBeEnabled();
});

test('the permission reads in Spanish', async ({ page }) => {
    await review(page, { key: users.holder, name: 'Phantom' }, '/es');
    await expect(heading(page)).toHaveText('Un permiso$10/ sem máx');
    await expect(page.getByRole('img', { name: 'Sin firmar: $10/SEM' })).toBeVisible();
    await expect(clauses(page).nth(4)).toContainText('Cada compra usa precios de Pyth on-chain.');
    await expect(page.locator('#permission-status')).toHaveText(
        /^Probado en devnet: pasa\. Vos pagás 0 SOL, Laterite 0,\d{4} SOL\.$/,
    );
    await expect(page.getByRole('button', { name: 'Firmar una vez' })).toBeEnabled();
});

for (const path of ['/', '/es']) {
    test(`on a 390px phone every clause holds one line, nothing scrolls sideways and Sign once is in view (${path})`, async ({
        browser,
    }) => {
        const context = await browser.newContext({ viewport: { height: 844, width: 390 } });
        const page = await context.newPage();
        await review(page, { key: users.holder, name: 'Phantom' }, path);
        await expect(clauses(page)).toHaveCount(5);
        await page.evaluate(() => document.fonts.ready);
        const rows = await clauses(page).evaluateAll(items =>
            items.map(item => {
                const [number, text] = [...item.children] as HTMLElement[];
                const range = document.createRange();
                range.selectNodeContents(text!);
                const width = range.getBoundingClientRect().width;
                return {
                    lines: Math.round(
                        text!.getBoundingClientRect().height / parseFloat(getComputedStyle(text!).lineHeight),
                    ),
                    spare: item.clientWidth - number!.getBoundingClientRect().width - width,
                    text: text!.textContent,
                    width,
                };
            }),
        );
        for (const clause of rows) {
            expect(clause.lines, clause.text ?? '').toBe(1);
            // Linux's Chromium, Android's included, sets the same text about 4% wider than macOS's
            expect(clause.spare, `${clause.text} leaves ${clause.spare.toFixed(1)}px`).toBeGreaterThanOrEqual(
                6 + (process.platform === 'linux' ? 0 : 0.04 * clause.width),
            );
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
        // the one action is in view with the clauses, its edge included, without scrolling
        await expect(page.locator('#permission-status')).not.toBeEmpty();
        const sign = page.getByRole('button', { name: path === '/' ? 'Sign once' : 'Firmar una vez' });
        const bottom = await sign.evaluate(button => {
            const edge = parseFloat(getComputedStyle(button).getPropertyValue('--edge')) || 0;
            return button.getBoundingClientRect().bottom + window.scrollY + edge;
        });
        console.log(`${path} Sign once ends at ${bottom.toFixed(1)} of 844 px`);
        expect(bottom).toBeLessThanOrEqual(844);
        await context.close();
    });
}

test('the band holds still while the transaction is tested', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { height: 844, width: 390 } });
    let release = () => {};
    const held = new Promise<void>(resolve => (release = resolve));
    await page.route('**/api/sponsor/prepare', async route => {
        await held;
        await route.continue();
    });
    await review(page, { key: users.holder, name: 'Phantom' });
    await expect(page.locator('#permission-status')).toHaveText('Testing it on devnet');
    await page.evaluate(() => document.fonts.ready);
    const note = page.locator('main p').first();
    // the note's box on the page and its type, whatever the scroll
    const box = () =>
        note.evaluate(element => {
            const { height, left, top, width } = element.getBoundingClientRect();
            const { fontSize, fontWeight } = getComputedStyle(element);
            return { font: `${fontWeight} ${fontSize}`, height, left, top: top + window.scrollY, width };
        });
    const checking = await box();
    // the screen opened at its top, its note set small (3.4u of a 350 px column)
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(checking.font).toBe('500 11.9px');
    release();
    await expect(page.locator('#permission-status')).toHaveText(tested);
    expect(await box()).toEqual(checking);
});
