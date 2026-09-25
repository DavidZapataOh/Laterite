import { describe, expect, it } from 'vitest';

import { button } from '../src/button';

describe('button', () => {
    it('has one class per variant', () => {
        expect(Object.keys(button).sort()).toEqual(['flat', 'inverse', 'outline', 'primary']);
    });
});
