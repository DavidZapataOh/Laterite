import { expect, test } from '@playwright/test';

for (const width of [390, 1440]) {
    test(`landing renders unchanged at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ height: 900, width });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto('/');
        await page.evaluate(async () => {
            await document.fonts.ready;
            for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight) {
                window.scrollTo(0, y);
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
            window.scrollTo(0, 0);
            await Promise.all(
                [...document.images].map(image => {
                    image.loading = 'eager';
                    return image.decode().catch(() => undefined);
                }),
            );
        });
        await expect(page).toHaveScreenshot(`landing-${width}.png`, { animations: 'disabled', fullPage: true });
    });
}

const buttons = [
    { name: 'Lay the first brick', nth: 0, slug: 'hero' },
    { name: 'Lay the first brick', nth: 1, slug: 'close' },
    { name: 'Launch app', nth: 0, slug: 'launch' },
];

for (const { name, nth, slug } of buttons) {
    test(`button ${slug} keeps its hover and press states`, async ({ page }) => {
        await page.setViewportSize({ height: 900, width: 1440 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto('/');
        await page.evaluate(() => document.fonts.ready);
        const link = page.getByRole('link', { name }).nth(nth);
        await link.scrollIntoViewIfNeeded();
        const box = await link.boundingBox();
        if (!box) throw new Error(`${slug} button is not visible`);
        const clip = { height: box.height + 24, width: box.width + 24, x: box.x - 12, y: box.y - 12 };

        await expect(page).toHaveScreenshot(`button-${slug}-rest.png`, { animations: 'disabled', clip });
        await link.hover();
        await expect(page).toHaveScreenshot(`button-${slug}-hover.png`, { animations: 'disabled', clip });
        await page.mouse.down();
        await expect(page).toHaveScreenshot(`button-${slug}-active.png`, { animations: 'disabled', clip });
        await page.mouse.up();
    });
}
