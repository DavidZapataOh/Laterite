import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const nextConfig: NextConfig = {
    transpilePackages: ['@laterite/i18n', '@laterite/ui'],
};

export default createNextIntlPlugin('./i18n/request.ts')(nextConfig);
