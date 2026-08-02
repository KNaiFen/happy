import { describe, expect, it } from 'vitest';
import { deriveCodexGatewayRootSessionIdentity } from './codexGatewayIdentity';

describe('deriveCodexGatewayRootSessionIdentity', () => {
    it('is deterministic per Gateway and thread while isolating both scopes', async () => {
        const seed = Buffer.alloc(32, 7).toString('base64url');
        const first = await deriveCodexGatewayRootSessionIdentity({
            gatewayId: 'gateway-a',
            sessionKeySeed: seed,
            threadId: 'thread-a',
        });
        const repeated = await deriveCodexGatewayRootSessionIdentity({
            gatewayId: 'gateway-a',
            sessionKeySeed: seed,
            threadId: 'thread-a',
        });
        const otherThread = await deriveCodexGatewayRootSessionIdentity({
            gatewayId: 'gateway-a',
            sessionKeySeed: seed,
            threadId: 'thread-b',
        });
        const otherGateway = await deriveCodexGatewayRootSessionIdentity({
            gatewayId: 'gateway-b',
            sessionKeySeed: seed,
            threadId: 'thread-a',
        });

        expect(repeated.tag).toBe(first.tag);
        expect(repeated.sessionKey).toEqual(first.sessionKey);
        expect(otherThread.tag).not.toBe(first.tag);
        expect(otherThread.sessionKey).not.toEqual(first.sessionKey);
        expect(otherGateway.tag).not.toBe(first.tag);
        expect(otherGateway.sessionKey).not.toEqual(first.sessionKey);
        expect(first.tag).not.toContain('thread-a');
    });

    it('rejects malformed seeds and identifiers', async () => {
        await expect(deriveCodexGatewayRootSessionIdentity({
            gatewayId: 'gateway-a',
            sessionKeySeed: 'short',
            threadId: 'thread-a',
        })).rejects.toThrow('session key seed');
        await expect(deriveCodexGatewayRootSessionIdentity({
            gatewayId: '',
            sessionKeySeed: Buffer.alloc(32).toString('base64url'),
            threadId: 'thread-a',
        })).rejects.toThrow('Gateway ID');
    });
});
