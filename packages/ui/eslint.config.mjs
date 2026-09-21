import { defineConfig } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
    ...nextVitals,
    ...nextTs,
    // A package has no pages directory for this rule to resolve links against.
    { rules: { '@next/next/no-html-link-for-pages': 'off' } },
]);
