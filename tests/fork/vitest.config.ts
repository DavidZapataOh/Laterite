import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        fileParallelism: false,
        globalSetup: './src/global-setup.ts',
        hookTimeout: 300_000,
        // The measurements are printed as well as written to reports/.
        silent: false,
        testTimeout: 600_000,
    },
});
