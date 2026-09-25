import { expect, test } from '@playwright/test';

const pages = [
    { path: '/', lang: 'en', title: 'Get paid. Lay a brick.', switchTo: 'Español', other: '/es' },
    { path: '/es', lang: 'es-AR', title: 'Un cobro. Un ladrillo.', switchTo: 'English', other: '/' },
];

const external = [
    'https://app.laterite.cash',
    'https://github.com/DavidZapataOh/Laterite',
    'https://github.com/DavidZapataOh/Laterite/tree/main/docs',
    'https://x.com/lateritecash',
];

for (const { path, lang, title, switchTo, other } of pages) {
    test(`${path} renders in ${lang}`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
            if (message.type() === 'error') errors.push(message.text());
        });
        const response = await page.goto(path, { waitUntil: 'networkidle' });
        expect(response?.status()).toBe(200);
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
        expect(errors).toEqual([]);
    });

    test(`${path} switches to ${switchTo} and back`, async ({ page }) => {
        await page.goto(path);
        await page.getByRole('contentinfo').getByRole('link', { name: switchTo }).click();
        await expect(page).toHaveURL(other);
        await page
            .getByRole('contentinfo')
            .getByRole('link', { name: pages.find(p => p.path === other)!.switchTo })
            .click();
        await expect(page).toHaveURL(path);
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
    });

    test(`${path} links only to real destinations`, async ({ page, request }) => {
        await page.goto(path);
        const hrefs = await page.locator('a[href]').evaluateAll(links => links.map(link => link.getAttribute('href')!));
        for (const href of new Set(hrefs)) {
            if (href.startsWith('#')) {
                await expect(page.locator(href), href).toHaveCount(1);
            } else if (href.startsWith('/')) {
                expect((await request.get(href)).status(), href).toBe(200);
            } else {
                expect(external, href).toContain(href);
            }
        }
        const footer = page.getByRole('contentinfo');
        for (const href of external.slice(1)) await expect(footer.locator(`a[href="${href}"]`)).toHaveCount(1);
    });
}

test('the cap names both caps and who enforces each', async ({ page }) => {
    await page.goto('/');
    const enforcers = page
        .getByRole('definition')
        .locator('..')
        .filter({ hasText: /in total|per token/ });
    await expect(page.locator('#how-it-works dl')).toHaveAccessibleName('Who enforces the cap');
    const rows = page.locator('#how-it-works dl > div');
    await expect(rows).toHaveText(['Laterite program$25 in total', 'Solana Subscriptions$25 per token']);
    await page.locator('#how-it-works label', { hasText: '$10' }).click();
    await expect(rows).toHaveText(['Laterite program$10 in total', 'Solana Subscriptions$10 per token']);
});
