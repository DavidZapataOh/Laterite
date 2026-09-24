import { cp, rm } from 'node:fs/promises';

import { build } from 'esbuild';

const dist = new URL('../dist/', import.meta.url);
await rm(dist, { force: true, recursive: true });
const result = await build({
    // CommonJS dependencies (pg, pino) call `require`, which an ES module bundle provides through `createRequire`.
    banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
    bundle: true,
    entryPoints: ['src/main.ts', 'src/migrate.ts'],
    external: ['pg-native'],
    format: 'esm',
    metafile: true,
    minify: true,
    outdir: 'dist',
    platform: 'node',
    sourcemap: true,
    target: 'node24',
});
await cp(new URL('../../../packages/db/migrations/', import.meta.url), new URL('migrations/', dist), {
    recursive: true,
});
for (const [file, { bytes }] of Object.entries(result.metafile.outputs)) {
    if (file.endsWith('.js')) console.log(`${file} ${bytes} bytes`);
}
