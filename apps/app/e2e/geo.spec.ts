import { expect, test } from '@playwright/test';

test.use({ viewport: { height: 844, width: 390 } });

test.describe('from the United States', () => {
    test.use({ extraHTTPHeaders: { 'x-vercel-ip-country': 'US' } });

    test('the band states it plainly and nothing proceeds', async ({ page }) => {
        const response = await page.goto('/');
        expect(response?.status()).toBe(451);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your regionUS');
        await expect(page.getByRole('img', { name: 'Unavailable: US' })).toBeVisible();
        await expect(page.getByRole('definition')).toHaveText(['Backed Assets', 'Not offered', 'Closed']);
        await expect(page.getByRole('button')).toHaveCount(0);
    });

    test('in Spanish too', async ({ page }) => {
        const response = await page.goto('/es');
        expect(response?.status()).toBe(451);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tu regiónUS');
        await expect(page.getByText('Laterite compra xStocks, y su emisor no los ofrece en tu región.')).toBeVisible();
    });

    test('the API refuses it', async ({ request }) => {
        const response = await request.post('/api/eligibility', { data: {} });
        expect(response.status()).toBe(451);
        expect(await response.json()).toEqual({ error: 'unavailable' });
    });
});

test.describe('from occupied Crimea', () => {
    test.use({ extraHTTPHeaders: { 'x-vercel-ip-country': 'UA', 'x-vercel-ip-country-region': '43' } });

    test('the region is named', async ({ page }) => {
        expect((await page.goto('/'))?.status()).toBe(451);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your regionUA-43');
    });
});

test.describe('from Argentina', () => {
    test.use({ extraHTTPHeaders: { 'x-vercel-ip-country': 'AR' } });

    test('the app opens, and the unavailable screen sends it home', async ({ page }) => {
        expect((await page.goto('/'))?.status()).toBe(200);
        await expect(page.getByRole('button', { name: 'Connect a wallet' })).toBeVisible();
        await page.goto('/es/unavailable');
        await expect(page).toHaveURL('/es');
    });
});
