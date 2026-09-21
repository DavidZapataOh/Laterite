import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    forbidOnly: !!process.env.CI,
    fullyParallel: true,
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    reporter: 'list',
    testDir: './e2e',
    use: { baseURL: 'http://127.0.0.1:3197' },
    webServer: {
        command: 'node node_modules/next/dist/bin/next start -p 3197',
        reuseExistingServer: false,
        url: 'http://127.0.0.1:3197',
    },
});
