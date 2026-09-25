import { defineConfig, devices } from '@playwright/test';

import { faucet, keypairJson, sponsor } from './e2e/support/keys';
import { APP_ORIGIN, APP_PORT } from './e2e/support/origin';
import { RPC_PORT } from './e2e/support/validator';

export default defineConfig({
    forbidOnly: !!process.env.CI,
    globalSetup: './e2e/global-setup.ts',
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    testDir: './e2e',
    use: { baseURL: APP_ORIGIN },
    webServer: {
        command: `node node_modules/next/dist/bin/next start -p ${APP_PORT}`,
        // the faucet's and the sponsor's server-only variables, pointed at the tests' chain and their own test keys
        env: {
            FAUCET_KEYPAIR: keypairJson(faucet),
            SPONSOR_KEYPAIR: keypairJson(sponsor),
            SOLANA_RPC_URL: `http://127.0.0.1:${RPC_PORT}`,
            SOLANA_WS_URL: `ws://127.0.0.1:${RPC_PORT + 1}`,
        },
        reuseExistingServer: false,
        url: APP_ORIGIN,
    },
});
