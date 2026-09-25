import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.LANDING_PORT ?? 3197);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
    forbidOnly: !!process.env.CI,
    fullyParallel: true,
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    testDir: './e2e',
    use: { baseURL: origin },
    webServer: {
        command: `node node_modules/next/dist/bin/next start -p ${port}`,
        reuseExistingServer: false,
        url: origin,
    },
});
