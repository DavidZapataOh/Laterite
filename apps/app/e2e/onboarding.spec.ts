import { expect, type Page, test } from '@playwright/test';

import { otherApp } from './support/chain';
import { testKey, users } from './support/keys';
import { CLOSED_RPC_PORT, RPC_PORT } from './support/validator';
import { installWallets, type TestWallet } from './support/wallets';

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
/** The band's note, clause by clause (the separator between them is drawn, not text). */
const note = (page: Page) => page.locator('main p').first().locator(':scope > span > span > span');
const review = (page: Page) => page.getByRole('button', { name: 'Review and sign' });
const row = (page: Page, name: string) => page.getByRole('radiogroup', { name }).or(page.getByRole('group', { name }));

async function open(page: Page, wallet: TestWallet, path = '/') {
    await installWallets(page, [wallet]);
    await page.goto(path);
    await page.getByRole('button', { name: /^(Connect|Conectar) / }).click();
}

test('a new wallet sees what a $1,000 payday would invest, and gets test dollars from the faucet', async ({ page }) => {
    const key = testKey(`faucet-${Date.now()}`);
    await open(page, { key, name: 'Phantom' });
    await page
        .getByRole('dialog', { name: 'Before you start' })
        .getByRole('button', { name: 'Sign declaration' })
        .click();
    await expect(heading(page)).toHaveText('If you get paid $1,000$5.00this week');
    await expect(note(page)).toHaveText(['First week $5', 'then $10/wk']);
    await expect(page.getByRole('img', { name: 'Preview: $10/WK' })).toBeVisible();
    await expect(row(page, 'Tokens')).toContainText('No test dollars yet');
    await expect(review(page)).toBeDisabled();
    await expect(page.getByText('Get test USDC and USDT first.')).toBeVisible();

    await page.getByRole('button', { name: 'Get test USDC and USDT' }).click();
    // a new chain's first transaction takes seconds to confirm; the faucet itself answers in about half a second
    await expect(page.getByRole('checkbox', { name: 'USDC' })).toBeChecked({ timeout: 60_000 });
    await expect(page.getByRole('checkbox', { name: 'USDT' })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Get test USDC and USDT' })).toHaveCount(0);
    await expect(page.getByText('You can change tokens later in settings, without leaving.')).toBeVisible();
    await expect(review(page)).toBeEnabled();
});

test('every choice moves the preview by the program’s rules', async ({ page }) => {
    await open(page, { key: users.holder, name: 'Solflare' });
    await expect(page.getByRole('checkbox', { name: 'USDC' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'USDT' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Stablecoins' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Income rule' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'SPYx' })).toBeChecked();

    await page.getByRole('radio', { name: '$25' }).check();
    await expect(page.getByRole('img', { name: 'Preview: $25/WK' })).toBeVisible();
    await expect(heading(page)).toContainText('$5.00');
    await expect(note(page)).toHaveText(['First week $5', 'then $25/wk']);

    await page.getByRole('radio', { name: 'I have savings' }).check();
    await expect(page.getByRole('radio', { name: 'Daily' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Income rule' })).not.toBeChecked();
    await expect(page.getByText('Buys once a day.')).toBeVisible();
    // a week from any hour but midnight touches eight UTC days: eight dollar buys
    await expect(note(page)).toHaveText(['First week $5', 'then $8/wk']);

    await page.getByRole('radio', { name: 'Weekly' }).check();
    await expect(page.getByText(/^Buys once a week in US market hours/)).toBeVisible();
    await page.getByRole('textbox', { name: 'Amount each buy' }).fill('30');
    await expect(page.getByText('The schedule cannot buy more than the weekly cap.')).toBeVisible();
    await expect(review(page)).toBeDisabled();
    await page.getByRole('textbox', { name: 'Amount each buy' }).fill('2.5');
    await expect(review(page)).toBeEnabled();

    await page.getByRole('radio', { name: 'Off' }).first().check();
    await expect(page.getByText('Turn on the schedule, the income rule or change per payment.')).toBeVisible();
    await page.getByRole('radio', { name: '2x' }).check();
    await expect(
        page.getByText('Rounds each payment you make up to the next dollar, $0.50 at least, times 2.'),
    ).toBeVisible();
    // change per payment counts payments made, so a payday invests nothing through it
    await expect(heading(page)).toContainText('$0.00');
    await expect(review(page)).toBeEnabled();

    await page.getByRole('checkbox', { name: 'Income rule' }).check();
    await page.getByRole('textbox', { name: 'Cushion in each token' }).fill('2,000');
    await expect(heading(page)).toContainText('$0.00');
    await expect(page.getByText(/^Your cushion keeps the rest/)).toBeVisible();
    await page.getByRole('textbox', { name: 'Cushion in each token' }).fill('twenty');
    await expect(page.getByText('Amounts are dollars and cents, like 20 or 12.50.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Cushion in each token' }).fill('20');

    await page.getByRole('textbox', { name: 'Goal name' }).fill('Casa en Córdoba con patio y parrilla');
    await expect(page.getByText(/^The goal’s name is too long: shorten it to 32 characters or fewer/)).toBeVisible();
    // the name scrolls in its own box: the amount beside it stays whole
    await page.getByRole('textbox', { name: 'Goal amount' }).fill('5,000');
    await expect(page.getByRole('textbox', { name: 'Goal amount' })).toBeInViewport({ ratio: 1 });
    await page.getByRole('textbox', { name: 'Goal name' }).fill('Casa en Córdoba');
    await page.getByRole('textbox', { name: 'Goal amount' }).fill('5,000');
    await page.getByRole('radio', { name: 'QQQx' }).check();
    await page.getByRole('checkbox', { name: 'USDT' }).uncheck();
    await expect(review(page)).toBeEnabled();
    await page.getByRole('checkbox', { name: 'USDC' }).uncheck();
    await expect(page.getByText('Choose USDC or USDT.')).toBeVisible();
});

test('a prior approval on a token account needs an explicit confirmation', async ({ page }) => {
    await open(page, { key: users.delegated, name: 'Backpack' });
    const notice = page.getByRole('alert').filter({ hasText: 'already lets' });
    const other = `${otherApp.address.slice(0, 4)}…${otherApp.address.slice(-4)}`;
    await expect(notice).toContainText(
        `Your USDC account already lets ${other} spend $40.00. Signing replaces that approval with Laterite’s capped one.`,
    );
    await expect(review(page)).toBeDisabled();
    await expect(page.getByText('Confirm replacing the existing approval first.')).toBeVisible();
    await notice.getByRole('checkbox', { name: 'Replace it' }).check();
    await expect(review(page)).toBeEnabled();
});

test('an exited wallet chooses again and is told what carries over', async ({ page }) => {
    await open(page, { key: users.exited, name: 'Backpack' });
    await expect(
        page.getByText(
            'Coming back keeps your first enrollment: no new trial week, this week’s spending counts, and what waited to invest was discarded when you left.',
        ),
    ).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'USDC' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'USDT' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Get test USDC and USDT' })).toBeVisible();
    await expect(review(page)).toBeEnabled();
});

test('onboarding is closed before any signature while the program is paused', async ({ page }) => {
    // this page reads the second chain, whose Config has the kill switch set
    await page.route(`http://127.0.0.1:${RPC_PORT}/**`, async route =>
        route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${CLOSED_RPC_PORT}/` }) }),
    );
    await open(page, { key: users.newcomer, name: 'Phantom' });
    await expect(heading(page)).toHaveText('EnrollmentClosed');
    await expect(page.getByText('Laterite’s program is paused')).toBeVisible();
    await expect(page.getByText('Nothing can be signed until it reopens. Your wallet is untouched.')).toBeVisible();
    await expect(review(page)).toHaveCount(0);
});

test('the preview reads in Spanish', async ({ page }) => {
    await open(page, { key: users.holder, name: 'Phantom' }, '/es');
    await expect(heading(page)).toHaveText('Si cobrás $1.000$5,00esta semana');
    await expect(note(page)).toHaveText(['Primera semana $5', 'después $10/sem']);
    await expect(page.getByRole('textbox', { name: 'Monto de la meta' })).toHaveAttribute('placeholder', '5.000');
    await page.getByRole('textbox', { name: 'Monto de la meta' }).fill('5.000');
    await expect(page.getByRole('button', { name: 'Revisar y firmar' })).toBeEnabled();
    await expect(page.getByRole('img', { name: 'Vista previa: $10/SEM' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revisar y firmar' })).toBeEnabled();
});

for (const [path, key] of [
    ['/', users.holder],
    ['/es', users.holder],
    ['/', users.newcomer],
    ['/es', users.newcomer],
] as const) {
    test(`on a 390px phone every row holds one line and nothing scrolls sideways (${path}, ${key === users.holder ? 'tokens' : 'no tokens'})`, async ({
        browser,
    }) => {
        const context = await browser.newContext({ viewport: { height: 844, width: 390 } });
        const page = await context.newPage();
        await open(page, { key, name: 'Phantom' }, path);
        await expect(page.getByRole('radiogroup').first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const rows = await page.locator('form [role="radiogroup"], form [role="group"]').evaluateAll(groups =>
            groups.map(group => {
                const [label, controls] = [...group.children] as HTMLElement[];
                const a = label!.getBoundingClientRect();
                const b = controls!.getBoundingClientRect();
                return {
                    label: label!.textContent,
                    // one line of chips: the controls are no taller than their first chip
                    controlLines: Math.round(b.height / controls!.firstElementChild!.getBoundingClientRect().height),
                    sameLine: a.top < b.bottom && b.top < a.bottom,
                    labelLines: Math.round(a.height / parseFloat(getComputedStyle(label!).lineHeight)),
                    text: [label!, ...controls!.children].reduce((sum, element) => {
                        const range = document.createRange();
                        range.selectNodeContents(element);
                        return sum + range.getBoundingClientRect().width;
                    }, 0),
                    // room left on the line once the label, the row's gap and every chip are laid out
                    spare:
                        group.clientWidth -
                        a.width -
                        parseFloat(getComputedStyle(group).columnGap) -
                        [...controls!.children].reduce(
                            (sum, chip) => sum + chip.getBoundingClientRect().width,
                            parseFloat(getComputedStyle(controls!).columnGap) * (controls!.children.length - 1),
                        ),
                };
            }),
        );
        for (const row of rows.filter(row => !row.label?.match(/^(Tokens)$/) || key === users.holder)) {
            expect(row, row.label ?? '').toMatchObject({ controlLines: 1, labelLines: 1, sameLine: true });
            // Linux's Chromium, Android's included, sets the same text about 4% wider than macOS's: measured elsewhere,
            // a row keeps that much more room than the 6px it keeps on Linux
            expect(row.spare, `${row.label} leaves ${row.spare.toFixed(1)}px`).toBeGreaterThanOrEqual(
                6 + (process.platform === 'linux' ? 0 : 0.04 * row.text),
            );
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
        // an over-long goal name scrolls in its own box: the amount stays whole inside the field
        await page.getByRole('textbox', { name: /^(Goal name|Nombre de la meta)$/ }).fill('x'.repeat(40));
        const amount = page.getByRole('textbox', { name: /^(Goal amount|Monto de la meta)$/ });
        await amount.fill('5,000');
        const [inner, outer, text, box] = await amount.evaluate((input: HTMLInputElement) => [
            input.getBoundingClientRect().right,
            input.parentElement!.getBoundingClientRect().right,
            input.scrollWidth,
            input.clientWidth,
        ]);
        expect(inner).toBeLessThanOrEqual(outer);
        expect(text).toBeLessThanOrEqual(box);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
        await context.close();
    });
}
