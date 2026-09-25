import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('.', import.meta.url)),
            // route handlers run here outside a React Server Components build
            'server-only': fileURLToPath(new URL('node_modules/server-only/empty.js', import.meta.url)),
        },
    },
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
        // next-intl imports `next/server` without an extension, which only a bundler resolves
        server: { deps: { inline: ['next-intl'] } },
    },
});
