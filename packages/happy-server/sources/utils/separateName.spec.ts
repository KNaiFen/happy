import { describe, it, expect } from 'vitest';
import { separateName } from './separateName';

describe('separateName', () => {
    it.each([
        ['John Doe', { firstName: 'John', lastName: 'Doe' }],
        ['John', { firstName: 'John', lastName: null }],
        ['John William Doe Smith', { firstName: 'John', lastName: 'William Doe Smith' }],
        ['', { firstName: null, lastName: null }],
        [null, { firstName: null, lastName: null }],
        [undefined, { firstName: null, lastName: null }],
        ['   ', { firstName: null, lastName: null }],
        ['  John    Doe  ', { firstName: 'John', lastName: 'Doe' }],
        ['José María', { firstName: 'José', lastName: 'María' }],
        ['Mary Smith-Johnson', { firstName: 'Mary', lastName: 'Smith-Johnson' }],
        ['John Michael Robert Smith-Johnson', { firstName: 'John', lastName: 'Michael Robert Smith-Johnson' }],
    ])('separates %j', (input, expected) => {
        expect(separateName(input)).toEqual(expected);
    });
});
