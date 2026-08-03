import { describe, expect, it } from 'vitest';
import {
    deriveCodexGatewayResumeSessionTag,
    deriveCodexGatewayRootSessionIdentity,
} from './codexGatewayIdentity';

describe('deriveCodexGatewayResumeSessionTag', () => {
    it('uses the supported V4 root prefix and remains deterministic', () => {
        const key = Buffer.alloc(32, 11);
        const first = deriveCodexGatewayResumeSessionTag(key);

        expect(first).toMatch(/^codex-gateway-root-v1-[A-Za-z0-9_-]+$/);
        expect(deriveCodexGatewayResumeSessionTag(key)).toBe(first);
        expect(deriveCodexGatewayResumeSessionTag(Buffer.alloc(32, 12))).not.toBe(first);
        expect(first).not.toContain(key.toString('base64url'));
    });

    it('rejects malformed data keys', () => {
        expect(() => deriveCodexGatewayResumeSessionTag(Buffer.alloc(31)))
            .toThrow('resume session data key');
    });
});

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
