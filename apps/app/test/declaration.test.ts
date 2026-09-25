import { describe, expect, it } from 'vitest';

import { declarationMessage, declarationProblem, DECLARATION_MAX_AGE_MS } from '@/lib/declaration';

import { signedDeclaration, translators } from './support';

describe('declarationMessage', () => {
    it('is the text the wallet reads, one statement a line', () => {
        const message = declarationMessage(translators.en, {
            domain: 'app.laterite.cash',
            issuedAt: '2026-09-24T22:00:00.000Z',
            wallet: 'LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf',
        });
        expect(message).toBe(
            [
                'Laterite eligibility declaration',
                'app.laterite.cash asks you to declare:',
                '- I am not a U.S. person and I am not in the United States.',
                '- I do not live in the United Kingdom, Canada, Australia, or any country where xStocks are prohibited or not offered.',
                '- I am not subject to international sanctions.',
                'Wallet: LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf',
                'Version: 1',
                'Issued at: 2026-09-24T22:00:00.000Z',
            ].join('\n'),
        );
    });
});

describe('declarationProblem', () => {
    it('accepts the wallet signature of the text, in either locale', async () => {
        for (const locale of ['en', 'es-AR'] as const) {
            const declaration = await signedDeclaration({ locale });
            expect(await declarationProblem(translators[locale], declaration)).toBeNull();
        }
    });

    it('refuses another text, host, wallet, time or signature', async () => {
        const declaration = await signedDeclaration();
        const other = await signedDeclaration();
        const problem = (changes: object, locale: keyof typeof translators = 'en') =>
            declarationProblem(translators[locale], { ...declaration, ...changes });
        expect(await problem({}, 'es-AR')).toBe('signature does not match');
        expect(await problem({ domain: 'laterite.example' })).toBe('signature does not match');
        expect(await problem({ wallet: other.wallet })).toBe('signature does not match');
        expect(await problem({ signature: other.signature })).toBe('signature does not match');
        expect(await problem({ wallet: 'not-an-address' })).toBe('wallet is not an address');
        expect(await problem({ issuedAt: 'yesterday' })).toBe('issuedAt is not an ISO time');
        expect(await problem({ signature: '0OIl' })).toBe('signature is not base58');
        expect(await problem({ signature: '1111' })).toBe('signature is not 64 bytes');
    });

    it('refuses a signature issued too long ago or ahead', async () => {
        const declaration = await signedDeclaration();
        const issued = Date.parse(declaration.issuedAt);
        const at = (now: number) => declarationProblem(translators.en, declaration, now);
        expect(await at(issued + DECLARATION_MAX_AGE_MS)).toBeNull();
        expect(await at(issued + DECLARATION_MAX_AGE_MS + 1)).toBe('issuedAt is too far from now');
        expect(await at(issued - DECLARATION_MAX_AGE_MS - 1)).toBe('issuedAt is too far from now');
    });
});
