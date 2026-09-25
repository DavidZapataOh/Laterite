/** The port `next start` serves the production build on for the browser tests. */
export const APP_PORT = Number(process.env.APP_PORT ?? 3402);

/** Where the browser tests open the app. */
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
