import { readdirSync, readFileSync } from 'node:fs';

import { type MessageFormatElement, parse, TYPE } from '@formatjs/icu-messageformat-parser';
import { describe, expect, it } from 'vitest';

import { defaultLocale, locales } from '../src/locales';

type Messages = { [key: string]: Messages | string };

const read = (locale: string): Messages =>
    JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));

/** Every message as `path → text`, nested keys joined with dots. */
function flatten(messages: Messages, prefix = ''): Map<string, string> {
    const flat = new Map<string, string>();
    for (const [key, value] of Object.entries(messages)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') flat.set(path, value);
        else for (const [nested, text] of flatten(value, path)) flat.set(nested, text);
    }
    return flat;
}

/** The ICU arguments and tags a message uses, with their types, so a translation cannot drop or rename one. */
function argumentsOf(elements: MessageFormatElement[], found = new Set<string>()): Set<string> {
    for (const element of elements) {
        if (element.type === TYPE.literal || element.type === TYPE.pound) continue;
        found.add(`${element.value}:${TYPE[element.type]}`);
        if (element.type === TYPE.plural || element.type === TYPE.select) {
            for (const option of Object.values(element.options)) argumentsOf(option.value, found);
        }
        if (element.type === TYPE.tag) argumentsOf(element.children, found);
    }
    return found;
}

describe('messages', () => {
    const reference = flatten(read(defaultLocale));

    it('ships one file per locale and nothing else', () => {
        const files = readdirSync(new URL('../messages', import.meta.url)).sort();
        expect(files).toEqual(locales.map(locale => `${locale}.json`).sort());
    });

    for (const locale of locales) {
        it(`${locale} has every key of ${defaultLocale} and no other`, () => {
            expect([...flatten(read(locale)).keys()].sort()).toEqual([...reference.keys()].sort());
        });

        it(`${locale} parses and keeps every argument`, () => {
            for (const [key, text] of flatten(read(locale))) {
                expect(text.trim(), key).not.toBe('');
                const own = argumentsOf(parse(text));
                expect([...own].sort(), key).toEqual([...argumentsOf(parse(reference.get(key)!))].sort());
            }
        });
    }
});
