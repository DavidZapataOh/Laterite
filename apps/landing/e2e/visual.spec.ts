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
