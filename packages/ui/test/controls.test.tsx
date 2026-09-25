import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Choice } from '../src/choice';
import { field } from '../src/field';

describe('Choice', () => {
    it('is a native radio inside its label, named by its text', () => {
        const html = renderToStaticMarkup(
            <Choice name="cap" value="0" defaultChecked>
                $10
            </Choice>,
        );
        expect(html).toMatch(
            /^<label class="[^"]+"><input type="radio" class="[^"]+" name="cap" checked="" value="0"\/>/,
        );
        expect(html).toContain('<span>$10</span></label>');
    });

    it('is a checkbox for a choice that stands alone', () => {
        const html = renderToStaticMarkup(
            <Choice type="checkbox" name="tokens" value="USDC" className="mono" disabled>
                USDC
            </Choice>,
        );
        expect(html).toMatch(/^<label class="\S+ mono"><input type="checkbox"/);
        expect(html).toContain('disabled=""');
    });
});

describe('field', () => {
    it('is one class', () => {
        expect(typeof field).toBe('string');
    });
});
