export const site = {
    name: 'Laterite',
    // Working values until the domains are final; the app lives on its own surface.
    url: 'https://laterite.cash',
    appUrl: 'https://app.laterite.cash',
    x: '@lateritecash',
    // Footer links render only once they have a real destination.
    links: [
        { key: 'docs', href: 'https://github.com/DavidZapataOh/Laterite/tree/main/docs' },
        { key: 'github', href: 'https://github.com/DavidZapataOh/Laterite' },
        { key: 'x', href: 'https://x.com/lateritecash' },
    ],
} as const;
