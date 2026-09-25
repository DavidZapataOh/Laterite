import { defineRailway, github, postgres, preserve, project, service } from 'railway/iac';

/**
 * Laterite's services on Railway: one always-on operator process and its Postgres. Secrets are set in Railway with
 * `railway variable set <NAME> --stdin`, never here; `preserve()` keeps each one as it is.
 */
export default defineRailway(() => {
    const db = postgres('postgres');
    const operator = service('operator', {
        build: {
            builder: 'DOCKERFILE',
            dockerfilePath: 'services/operator/Dockerfile',
            watchPatterns: [
                'clients/typescript/src/**',
                'packages/db/**',
                'packages/devnet/addresses.json',
                'packages/devnet/src/**',
                'services/operator/**',
                'package.json',
                'pnpm-lock.yaml',
                'pnpm-workspace.yaml',
            ],
        },
        env: {
            CRANK_KEYPAIR: preserve(),
            DATABASE_URL: db.env.DATABASE_URL,
            MAINNET_FALLBACK_RPC_URL: preserve(),
            MAINNET_RPC_URL: preserve(),
            OPS_TELEGRAM_BOT_TOKEN: preserve(),
            OPS_TELEGRAM_CHAT_ID: preserve(),
            PYTH_PRO_ACCESS_TOKEN: preserve(),
            SOLANA_RPC_URL: preserve(),
        },
        healthcheck: '/health',
        healthcheckTimeout: 120,
        preDeploy: 'node migrate.js',
        replicas: 1,
        source: github('DavidZapataOh/Laterite', { branch: 'main' }),
    });
    return project('laterite', { resources: [db, operator] });
});
