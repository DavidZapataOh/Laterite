import { eq } from 'drizzle-orm';
import { expect, test } from '@playwright/test';
import { createDatabase, eligibilityDeclarations } from '@laterite/db';

import { testKey } from './support/keys';
import { installWallets } from './support/wallets';

test.use({ extraHTTPHeaders: { 'x-vercel-ip-country': 'AR' }, viewport: { height: 844, width: 390 } });

const recorded = async (wallet: string) => {
    const db = createDatabase(process.env.DATABASE_URL!);
    try {
        return await db.select().from(eligibilityDeclarations).where(eq(eligibilityDeclarations.wallet, wallet));
    } finally {
        await db.$client.end();
    }
};

test('a new wallet declares once, and the declaration is recorded with its country', async ({ page }) => {
    const key = testKey(`declare-${Date.now()}`);
    await installWallets(page, [{ key, name: 'Phantom' }]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect Phantom' }).click();
    const layer = page.getByRole('dialog', { name: 'Before you start' });
    await expect(layer.getByRole('listitem')).toHaveText([
        'I am not a U.S. person and I am not in the United States.',
        'I do not live in the United Kingdom, Canada, Australia, or any country where xStocks are prohibited or not offered.',
        'I am not subject to international sanctions.',
    ]);
    await page.keyboard.press('Escape');
    await expect(layer).toBeVisible();

    await layer.getByRole('button', { name: 'Sign declaration' }).click();
    await expect(layer).toBeHidden();
    await expect(page.getByText('Nothing signed yet')).toBeVisible();
    const [row] = await recorded(key.address);
    expect(row).toMatchObject({ country: 'AR', declarationVersion: '1', wallet: key.address });
    expect(row.message).toContain(`127.0.0.1:3402 asks you to declare:\n- I am not a U.S. person`);

    await page.reload();
    await expect(page.getByText('Nothing signed yet')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeHidden();
});

test('the declaration is read and signed in Spanish', async ({ page }) => {
    const key = testKey(`declara-${Date.now()}`);
    await installWallets(page, [{ key, name: 'Solflare' }]);
    await page.goto('/es');
    await page.getByRole('button', { name: 'Conectar Solflare' }).click();
    const layer = page.getByRole('dialog', { name: 'Antes de empezar' });
    await layer.getByRole('button', { name: 'Firmar declaración' }).click();
    await expect(layer).toBeHidden();
    const [row] = await recorded(key.address);
    expect(row.message).toContain('- No soy una persona estadounidense y no estoy en los Estados Unidos.');
});

test('a declined signature records nothing, and the wallet can leave', async ({ page }) => {
    const key = testKey(`decline-${Date.now()}`);
    await installWallets(page, [{ key, name: 'Backpack', rejectSign: true }]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect Backpack' }).click();
    const layer = page.getByRole('dialog', { name: 'Before you start' });
    await layer.getByRole('button', { name: 'Sign declaration' }).click();
    await expect(layer.getByRole('alert')).toHaveText('The declaration was not signed.');
    expect(await recorded(key.address)).toEqual([]);
    await layer.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByRole('button', { name: 'Connect Backpack' })).toBeVisible();
    await expect(layer).toBeHidden();
});

test('a signature of another text is refused, recorded nowhere, and the layer stays', async ({ page }) => {
    const key = testKey(`tamper-${Date.now()}`);
    await installWallets(page, [{ key, name: 'Phantom', signOther: true }]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect Phantom' }).click();
    const layer = page.getByRole('dialog', { name: 'Before you start' });
    await layer.getByRole('button', { name: 'Sign declaration' }).click();
    await expect(layer.getByRole('alert')).toHaveText('The declaration could not be recorded.');
    await expect(layer).toBeVisible();
    expect(await recorded(key.address)).toEqual([]);
});
