import { expect, test } from '@playwright/test';

test.use({ viewport: { height: 844, width: 390 } });

test('the welcome screen is complete in English', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Weekly cap$10/ wk');
    await expect(page.getByText('or $25 · first week $5')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect a wallet' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'No permission: $0/WK' })).toBeVisible();
    await expect(page.getByRole('definition')).toHaveText(['None', 'Once', 'Any time']);
    await expect(page.getByRole('listitem').first()).toHaveText('Devnet');
});

test('the band is sized by its content: the label sits right under the bar, the note never orphans a word', async ({
    page,
}) => {
    await page.goto('/');
    const bar = await page.getByRole('banner').boundingBox();
    const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
    // 10.7 column units (37px at 390) between the bar and the label, as in the comp
    expect(heading!.y - (bar!.y + bar!.height)).toBeLessThan(45);
    await expect(page.getByText('or $25 · first week $5')).toHaveCSS('text-wrap-style', 'balance');
});

test('the welcome screen is complete in Spanish', async ({ page }) => {
    await page.goto('/es');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es-AR');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tope semanal$10/ sem');
    await expect(page.getByRole('button', { name: 'Conectar una billetera' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Sin permiso: $0/SEM' })).toBeVisible();
    await expect(page.getByRole('definition')).toHaveText(['Ninguna', 'Una vez', 'Cuando quieras']);
});

test('the language chip switches between English and Spanish', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Leer en español' }).click();
    await expect(page).toHaveURL('/es');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Tope semanal');
    await page.getByRole('link', { name: 'Read in English' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Weekly cap');
});

test('desktop centres the phone composition on full-bleed fields', async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto('/');
    const band = await page.locator('main section').boundingBox();
    const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
    expect(band?.width).toBe(1440);
    expect(heading!.x).toBeGreaterThan(400);
    expect(heading!.x + heading!.width).toBeLessThan(1040);
});

test('the build keeps its direction contract', async ({ page }) => {
    await page.goto('/');
    expect(await page.content()).toContain('FORM: The terracotta band, surface round, seed 77e90a30.');
});
