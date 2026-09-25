import { expect, type Page, test } from '@playwright/test';

import { testKey, users } from './support/keys';
import { installWallets } from './support/wallets';

test.use({ viewport: { height: 844, width: 390 } });

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
// Next.js keeps an empty alert of its own for route announcements
const notice = (page: Page) => page.getByRole('alert').filter({ hasText: /\S/ });

async function disconnect(page: Page, address: string) {
    await page.getByRole('button', { name: `Wallet ${address.slice(0, 4)}…${address.slice(-4)}` }).click();
    await expect(page.getByText(address)).toBeVisible();
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByRole('button', { name: /^Connect/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Wallet/ })).toHaveCount(0);
}

test('Phantom, the only wallet of its own browser, connects in one tap and disconnects', async ({ page }) => {
    await installWallets(page, [{ key: users.newcomer, name: 'Phantom' }]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect Phantom' }).click();
    await expect(heading(page)).toHaveText('Weekly cap$0/ wk');
    await expect(page.getByText('Nothing signed yet')).toBeVisible();
    await expect(page.getByText('Next: choose your weekly cap, then sign one permission.')).toBeVisible();
    await expect(page.getByRole('img', { name: 'No permission: $0/WK' })).toBeVisible();
    await disconnect(page, users.newcomer.address);
    await expect(heading(page)).toHaveText('Weekly cap$10/ wk');
});

test('Solflare, chosen among three, reads an active enrollment', async ({ page }) => {
    await installWallets(page, [
        { key: testKey('phantom'), name: 'Phantom' },
        { key: users.active, name: 'Solflare' },
        { key: testKey('backpack'), name: 'Backpack' },
    ]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect a wallet' }).click();
    const layer = page.getByRole('dialog', { name: 'Choose a wallet' });
    await expect(layer.getByRole('button')).toHaveText(['Phantom', 'Solflare', 'Backpack', 'Close']);
    // outline buttons take their placement's mono face, not the button's inherited Archivo
    await expect(layer.getByRole('button', { name: 'Solflare' })).toHaveCSS('font-family', /Martian Mono/);
    await layer.getByRole('button', { name: 'Solflare' }).click();
    await expect(heading(page)).toHaveText('Weekly cap$25/ wk');
    await expect(page.getByText('Active since Sep 20, 2026')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Active: $25/WK' })).toBeVisible();
    // base58 is case-sensitive: the chip shows the address as it is, not uppercased
    const { address } = users.active;
    expect(await page.getByRole('button', { name: /^Wallet / }).innerText()).toBe(
        `${address.slice(0, 4)}…${address.slice(-4)}`,
    );
    await disconnect(page, address);
});

test('Backpack reads an exited account, and a paused one in Spanish', async ({ page }) => {
    await installWallets(page, [{ key: users.exited, name: 'Backpack' }]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect Backpack' }).click();
    await expect(page.getByText('You left · the account stays')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Revoked: $0/WK' })).toBeVisible();
    await disconnect(page, users.exited.address);

    const paused = await page.context().newPage();
    await installWallets(paused, [{ key: users.paused, name: 'Backpack' }]);
    await paused.goto('/es');
    await paused.getByRole('button', { name: 'Conectar Backpack' }).click();
    await expect(heading(paused)).toHaveText('Tope semanal$10/ sem');
    await expect(paused.getByText('En pausa · alta el 20 sept 2026')).toBeVisible();
    await expect(paused.getByRole('img', { name: 'En pausa: $10/SEM' })).toBeVisible();
});

test('a wallet stays connected across a reload and a language switch', async ({ page }) => {
    await installWallets(page, [{ key: users.active, name: 'Phantom' }]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect Phantom' }).click();
    await expect(heading(page)).toHaveText('Weekly cap$25/ wk');
    await page.reload();
    await expect(heading(page)).toHaveText('Weekly cap$25/ wk');
    await page.getByRole('link', { name: 'Leer en español' }).click();
    await expect(heading(page)).toHaveText('Tope semanal$25/ sem');
});

test('connecting keeps the screen and names the wallet it waits on in the action', async ({ page }) => {
    await installWallets(page, [{ holdConnect: true, key: users.active, name: 'Phantom' }]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect Phantom' }).click();
    await expect(page.getByRole('button', { name: 'Approve in Phantom' })).toBeDisabled();
    await expect(heading(page)).toHaveText('Weekly cap$10/ wk');
    await page.evaluate(() => (window as unknown as { approve: () => void }).approve());
    await expect(heading(page)).toHaveText('Weekly cap$25/ wk');
});

test('a declined connection says so in crimson, and the band tries again', async ({ page }) => {
    await installWallets(page, [{ key: users.active, name: 'Phantom', rejectConnect: true }]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect Phantom' }).click();
    const alert = notice(page);
    await expect(alert).toContainText('Phantom did not connect: the request was declined.');
    await expect(alert).toHaveCSS('color', 'rgb(163, 18, 58)');
    // the band's own action is the one recovery
    await expect(alert.getByRole('button')).toHaveCount(0);
    await page.getByRole('button', { name: 'Connect Phantom' }).click();
    await expect(alert).toContainText('Phantom did not connect');
});

test('without a supported wallet, the layer opens the page inside each one', async ({ page }) => {
    await page.goto('/es');
    await page.getByRole('button', { name: 'Conectar una billetera' }).click();
    const layer = page.getByRole('dialog', { name: 'Elegí una billetera' });
    const here = encodeURIComponent('http://127.0.0.1:3402/es');
    const ref = encodeURIComponent('http://127.0.0.1:3402');
    await expect(layer.getByRole('link', { name: 'Abrir en Phantom' })).toHaveAttribute(
        'href',
        `https://phantom.app/ul/browse/${here}?ref=${ref}`,
    );
    await expect(layer.getByRole('link', { name: 'Abrir en Solflare' })).toHaveAttribute(
        'href',
        `https://solflare.com/ul/v1/browse/${here}?ref=${ref}`,
    );
    await expect(layer.getByRole('link', { name: 'Abrir en Backpack' })).toHaveAttribute(
        'href',
        `https://backpack.app/ul/v1/browse/${here}?ref=${ref}`,
    );
    await layer.getByRole('button', { name: 'Cerrar' }).click();
    await expect(layer).toBeHidden();
});

test('an unanswered devnet read says so and retries', async ({ page }) => {
    await installWallets(page, [{ key: users.active, name: 'Phantom' }]);
    await page.route('http://127.0.0.1:48899/**', route => route.abort());
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect Phantom' }).click();
    await expect(notice(page)).toContainText('Devnet did not answer.');
    await page.unroute('http://127.0.0.1:48899/**');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(heading(page)).toHaveText('Weekly cap$25/ wk');
});
