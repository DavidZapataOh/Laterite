import { expect, type Page, test } from '@playwright/test';

const SITE = 'https://laterite.cash';

const pages = [
    {
        path: '/',
        url: SITE,
        locale: 'en_US',
        title: 'Laterite · Get paid. Lay a brick.',
        description:
            'Every payday, a capped slice of your dollars becomes S&P 500. Automatically, from your own wallet.',
        alt: 'Laterite. Get paid. Lay a brick.',
    },
    {
        path: '/es',
        url: `${SITE}/es`,
        locale: 'es_AR',
        title: 'Laterite · Un cobro. Un ladrillo.',
        description:
            'En cada cobro, una parte con tope de tus dólares se vuelve S&P 500. En automático, desde tu propia billetera.',
        alt: 'Laterite. Un cobro. Un ladrillo.',
    },
];

const meta = (page: Page, key: string) =>
    page.locator(`head meta[property="${key}"], head meta[name="${key}"]`).getAttribute('content');

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

for (const { path, url, locale, title, description, alt } of pages) {
    test(`${path} carries its metadata, Open Graph and Twitter cards`, async ({ page, request }) => {
        await page.goto(path);
        await expect(page).toHaveTitle(title);
        expect(await meta(page, 'description')).toBe(description);
        expect(await page.locator('head link[rel="canonical"]').getAttribute('href')).toBe(url);
        const alternates = await page
            .locator('head link[rel="alternate"][hreflang]')
            .evaluateAll(links => links.map(link => `${link.getAttribute('hreflang')} ${link.getAttribute('href')}`));
        expect(alternates.sort()).toEqual([`en ${SITE}`, `es-AR ${SITE}/es`, `x-default ${SITE}`]);

        expect(await meta(page, 'og:type')).toBe('website');
        expect(await meta(page, 'og:site_name')).toBe('Laterite');
        expect(await meta(page, 'og:locale')).toBe(locale);
        expect(await meta(page, 'og:url')).toBe(url);
        expect(await meta(page, 'og:title')).toBe(title);
        expect(await meta(page, 'og:description')).toBe(description);
        expect(await meta(page, 'twitter:card')).toBe('summary_large_image');
        expect(await meta(page, 'twitter:site')).toBe('@lateritecash');
        expect(await meta(page, 'twitter:creator')).toBe('@lateritecash');
        expect(await meta(page, 'twitter:title')).toBe(title);
        expect(await meta(page, 'twitter:description')).toBe(description);

        for (const card of ['og', 'twitter']) {
            expect(await meta(page, `${card}:image:alt`)).toBe(alt);
            expect(await meta(page, `${card}:image:width`)).toBe('1200');
            expect(await meta(page, `${card}:image:height`)).toBe('630');
            expect(await meta(page, `${card}:image:type`)).toBe('image/png');
            const image = new URL((await meta(page, `${card}:image`))!);
            expect(image.origin).toBe(SITE);
            const response = await request.get(image.pathname + image.search);
            expect(response.status()).toBe(200);
            expect(response.headers()['content-type']).toBe('image/png');
            const bytes = await response.body();
            expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
            expect(bytes.length).toBeLessThan(5_000_000);
        }
    });
}

test('each locale shares its own card', async ({ page, request }) => {
    const cards: Buffer[] = [];
    for (const { path } of pages) {
        await page.goto(path);
        const image = new URL((await meta(page, 'og:image'))!);
        cards.push(await (await request.get(image.pathname + image.search)).body());
    }
    expect(cards[0].equals(cards[1])).toBe(false);
});
