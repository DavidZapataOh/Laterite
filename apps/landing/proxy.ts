import createMiddleware from 'next-intl/middleware';
import { routing } from '@laterite/i18n/routing';

export default createMiddleware(routing);

export const config = {
    // The social cards are addressed by their internal locale segment (`/es-AR/opengraph-image/…`) and bypass routing
    matcher: '/((?!_next|_vercel|[^/]+/(?:opengraph|twitter)-image/|.*\\..*).*)',
};
