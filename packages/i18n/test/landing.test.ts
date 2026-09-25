import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { locales } from '../src/locales';

type Messages = { [key: string]: Messages | string };

const landingOf = (locale: string): Messages =>
    JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8')).landing;

/** Words as a reader counts them: tokens with a letter or a digit, after arguments take the landing's example values. */
function words(text: string): number {
    const filled = text.replace(/\{cap\}/g, '$25');
    return filled.split(/\s+/).filter(token => /[\p{L}\p{N}]/u.test(token)).length;
}

const text = (messages: Messages, path: string): string => {
    const value = path.split('.').reduce<Messages | string>((node, key) => (node as Messages)[key], messages);
    if (typeof value !== 'string') throw new Error(`${path} is not a message`);
    return value;
};

const leaves = (messages: Messages, path: string): string[] =>
    Object.values(path.split('.').reduce<Messages>((node, key) => node[key] as Messages, messages)) as string[];

const BANDS = ['cap', 'autopilot', 'yours', 'wall', 'cannot', 'close'];
const LINES = ['cap.line', 'autopilot.line', 'yours.line'];

/**
 * The copy a visitor reads: the nav, the hero, every band's headline, receipt line, note, list and action. Accessible
 * names, the example fragments' labels and figures, the stamps, the footer and the metadata are not counted.
 */
function pageCopy(landing: Messages): string[] {
    return [
        text(landing, 'nav.howItWorks'),
        text(landing, 'nav.launch'),
        ...['first', 'second', 'third', 'sentence', 'cta', 'next'].map(key => text(landing, `hero.${key}`)),
        ...leaves(landing, 'hero.chips'),
        ...BANDS.map(band => text(landing, `${band}.headline`)),
        ...LINES.map(line => text(landing, line)),
        text(landing, 'wall.note'),
        ...leaves(landing, 'cannot.limits'),
        ...leaves(landing, 'builtOn.stack'),
        text(landing, 'close.cta'),
    ];
}

describe('landing copy', () => {
    for (const locale of locales) {
        const landing = landingOf(locale);

        it(`${locale} keeps the hero within 20 words`, () => {
            const hero = ['first', 'second', 'third', 'sentence'].map(key => text(landing, `hero.${key}`));
            expect(words(hero.join(' '))).toBeLessThanOrEqual(20);
        });

        it(`${locale} keeps every headline within 4 words and every receipt line within 12`, () => {
            for (const band of BANDS) expect(words(text(landing, `${band}.headline`)), band).toBeLessThanOrEqual(4);
            for (const line of LINES) expect(words(text(landing, line)), line).toBeLessThanOrEqual(12);
        });

        it(`${locale} keeps the whole page within 130 words`, () => {
            expect(words(pageCopy(landing).join(' '))).toBeLessThanOrEqual(130);
        });
    }
});
