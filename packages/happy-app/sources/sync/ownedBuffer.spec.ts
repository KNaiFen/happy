import { describe, expect, it } from 'vitest';

import { replaceOwnedBuffer } from './ownedBuffer';

describe('replaceOwnedBuffer', () => {
    it('copies a replacement before clearing the previously owned buffer', () => {
        const buffers = new Map<string, Uint8Array>();
        const input = new Uint8Array(32).fill(7);
        const firstOwned = replaceOwnedBuffer(buffers, 'machine-1', input);

        const secondOwned = replaceOwnedBuffer(buffers, 'machine-1', firstOwned);

        expect(firstOwned).toEqual(new Uint8Array(32));
        expect(secondOwned).toEqual(input);
        expect(secondOwned).not.toBe(firstOwned);
        expect(buffers.get('machine-1')).toBe(secondOwned);
    });
});
