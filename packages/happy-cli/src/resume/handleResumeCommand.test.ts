import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockExistsSync: vi.fn(),
    mockResumeCodexGatewayTui: vi.fn(),
    mockResolveLocalReconnectableSession: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, existsSync: mocks.mockExistsSync };
});

vi.mock('@/codex/gateway/codexGatewayResume', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/codex/gateway/codexGatewayResume')>();
    return {
        ...actual,
        resumeCodexGatewayTui: mocks.mockResumeCodexGatewayTui,
    };
});

vi.mock('./localResumeStore', () => {
    class MockLocalResumeSessionError extends Error {
        constructor(message: string, public readonly code: 'not_found' | 'ambiguous' | 'unavailable') {
            super(message);
            this.name = 'LocalResumeSessionError';
        }
    }
    return {
        LocalResumeSessionError: MockLocalResumeSessionError,
        resolveLocalReconnectableSession: mocks.mockResolveLocalReconnectableSession,
    };
});

import { resumeCodexGatewayTui } from '@/codex/gateway/codexGatewayResume';
import { buildResumeBootstrap, formatResumeHelp, handleResumeCommand, parseResumeCommandArgs } from './handleResumeCommand';
import { LocalResumeSessionError } from './localResumeStore';

function createReconnectableSession() {
    return {
        id: 'session-1',
        active: false,
        metadata: {
            path: '/tmp/repo',
            flavor: 'codex',
            codexSyncVersion: 4 as const,
            codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
            host: 'localhost',
            homeDir: '/tmp',
            happyHomeDir: '/tmp/.happy',
            happyLibDir: '/tmp/happy',
            happyToolsDir: '/tmp/happy/tools',
        },
        seq: 42,
        metadataVersion: 7,
        agentStateVersion: 9,
        encryptionKey: new Uint8Array(32).fill(7),
        encryptionVariant: 'dataKey' as const,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockExistsSync.mockReturnValue(true);
    mocks.mockResumeCodexGatewayTui.mockResolvedValue(0);
    mocks.mockResolveLocalReconnectableSession.mockRejectedValue(
        new LocalResumeSessionError('no local session', 'not_found'),
    );
});

afterEach(() => vi.unstubAllEnvs());

describe('parseResumeCommandArgs', () => {
    it('parses the Happy session id', () => {
        expect(parseResumeCommandArgs(['cmmij8olq00dp5jcxr3wtbpau'])).toEqual({
            showHelp: false,
            sessionId: 'cmmij8olq00dp5jcxr3wtbpau',
        });
    });

    it('recognizes help flags', () => {
        expect(parseResumeCommandArgs(['--help'])).toEqual({ showHelp: true, sessionId: '' });
    });

    it('rejects missing session ids', () => {
        expect(() => parseResumeCommandArgs([])).toThrow('Happy session ID is required: happy resume <session-id>');
    });
});

describe('buildResumeBootstrap', () => {
    it('builds a private Codex Sync V4 resume bootstrap', () => {
        expect(buildResumeBootstrap(createReconnectableSession())).toEqual({
            happySessionId: 'session-1',
            dataEncryptionKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
            threadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
            cwd: '/tmp/repo',
            model: null,
            permissionMode: 'default',
            effortLevel: null,
        });
    });

    it('preserves session-level Codex permission, model, and effort choices', () => {
        const metadata = {
            ...createReconnectableSession().metadata,
            permissionMode: 'read-only',
            modelMode: 'gpt-5.5',
            effortLevel: 'max',
        };
        expect(buildResumeBootstrap({
            ...createReconnectableSession(),
            id: 'session-modes',
            metadata,
        })).toMatchObject({
            permissionMode: 'read-only',
            model: 'gpt-5.5',
            effortLevel: 'max',
        });
    });

    it('rejects a session without the explicit V4 marker', () => {
        const metadata = { ...createReconnectableSession().metadata };
        delete (metadata as { codexSyncVersion?: 4 }).codexSyncVersion;
        expect(() => buildResumeBootstrap({
            ...createReconnectableSession(),
            id: 'session-2',
            metadata,
        })).toThrow(
            'Happy session session-2 uses unsupported flavor "codex".',
        );
    });
});

describe('formatResumeHelp', () => {
    it('mentions the session id command shape', () => {
        expect(formatResumeHelp()).toContain('happy resume <happy-session-id>');
    });
});

describe('handleResumeCommand', () => {
    it('resumes from local persisted V4 encryption data', async () => {
        const session = createReconnectableSession();
        mocks.mockResolveLocalReconnectableSession.mockResolvedValue(session);

        await handleResumeCommand(['session-1']);

        expect(resumeCodexGatewayTui).toHaveBeenCalledWith(expect.objectContaining({
            happySessionId: 'session-1',
            threadId: session.metadata.codexThreadId,
            cwd: '/tmp/repo',
        }));
    });

    it('does not fall back to legacy account credentials', async () => {
        mocks.mockResolveLocalReconnectableSession.mockRejectedValue(
            new LocalResumeSessionError('no local session material', 'not_found'),
        );

        await expect(handleResumeCommand(['missing'])).rejects.toThrow('no local session material');
        expect(resumeCodexGatewayTui).not.toHaveBeenCalled();
    });

    it('rejects legacy account encryption before touching the Gateway', async () => {
        mocks.mockResolveLocalReconnectableSession.mockResolvedValue({
            ...createReconnectableSession(),
            encryptionVariant: 'legacy',
        });
        await expect(handleResumeCommand(['session-1'])).rejects.toThrow('independent Sync v4 data key');
        expect(resumeCodexGatewayTui).not.toHaveBeenCalled();
    });
});
