import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    forbidOnly: !!process.env.CI,
    globalSetup: './e2e/global-setup.ts',
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    testDir: './e2e',
    use: { baseURL: 'http://127.0.0.1:3402' },
    webServer: {
        command: 'node node_modules/next/dist/bin/next start -p 3402',
        reuseExistingServer: false,
        url: 'http://127.0.0.1:3402',
    },
});
