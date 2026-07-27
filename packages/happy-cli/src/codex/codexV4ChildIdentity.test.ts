import { describe, expect, it } from 'vitest';
import { deriveCodexV4ChildSessionIdentity } from './codexV4ChildIdentity';

describe('deriveCodexV4ChildSessionIdentity', () => {
    it('is stable, opaque, and isolated for each child thread', async () => {
        const parentSessionKey = new Uint8Array(32).fill(9);
        const first = await deriveCodexV4ChildSessionIdentity({
            parentSessionId: 'happy-parent',
            parentSessionKey,
            childThreadId: 'provider-child-a',
        });
        const repeated = await deriveCodexV4ChildSessionIdentity({
            parentSessionId: 'happy-parent',
            parentSessionKey,
            childThreadId: 'provider-child-a',
        });
        const second = await deriveCodexV4ChildSessionIdentity({
            parentSessionId: 'happy-parent',
            parentSessionKey,
            childThreadId: 'provider-child-b',
        });

        expect(repeated).toEqual(first);
        expect(first.tag).not.toContain('provider-child-a');
        expect(first.tag).not.toBe(second.tag);
        expect(first.sessionKey).not.toEqual(second.sessionKey);
        expect(first.sessionKey).not.toEqual(parentSessionKey);
        expect(first.sessionKey).toHaveLength(32);
    });
});
