import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPED_ENV_KEYS } from '@/daemon/sessionEnvironment';

const mocks = vi.hoisted(() => ({
    mockExistsSync: vi.fn(),
    mockSpawnHappyCLI: vi.fn(),
    mockResolveLocalReconnectableSession: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, existsSync: mocks.mockExistsSync };
});

vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.mockSpawnHappyCLI }));

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

import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { buildResumeLaunch, formatResumeHelp, handleResumeCommand, parseResumeCommandArgs } from './handleResumeCommand';
import { LocalResumeSessionError } from './localResumeStore';

function createChildProcess(exitCode: number | null = 0) {
    const handlers = new Map<string, (...args: any[]) => void>();
    return {
        once: vi.fn((event: string, handler: (...args: any[]) => void) => {
            handlers.set(event, handler);
            if (event === 'exit') queueMicrotask(() => handler(exitCode, null));
        }),
    };
}

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
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'dataKey' as const,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockExistsSync.mockReturnValue(true);
    mocks.mockSpawnHappyCLI.mockReturnValue(createChildProcess());
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

describe('buildResumeLaunch', () => {
    it('builds a Codex Sync V4 resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-1',
            active: false,
            metadata: createReconnectableSession().metadata,
        })).toEqual({
            cwd: '/tmp/repo',
            args: ['codex', '--resume', '019ccca5-726b-7c61-b914-16de27dfab6e'],
        });
    });

    it('preserves session-level Codex permission, model, and effort choices', () => {
        const metadata = {
            ...createReconnectableSession().metadata,
            permissionMode: 'read-only',
            modelMode: 'gpt-5.5',
            effortLevel: 'max',
        };
        expect(buildResumeLaunch({ id: 'session-modes', active: false, metadata })).toEqual({
            cwd: '/tmp/repo',
            args: [
                'codex', '--resume', '019ccca5-726b-7c61-b914-16de27dfab6e',
                '--permission-mode', 'read-only', '--model', 'gpt-5.5', '--effort', 'max',
            ],
        });
    });

    it('rejects a session without the explicit V4 marker', () => {
        const metadata = { ...createReconnectableSession().metadata };
        delete (metadata as { codexSyncVersion?: 4 }).codexSyncVersion;
        expect(() => buildResumeLaunch({ id: 'session-2', active: false, metadata })).toThrow(
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
        for (const key of SESSION_SCOPED_ENV_KEYS) vi.stubEnv(key, `stale-${key}`);

        await handleResumeCommand(['session-1']);

        expect(spawnHappyCLI).toHaveBeenCalledWith(['codex', '--resume', session.metadata.codexThreadId], {
            cwd: '/tmp/repo',
            stdio: 'inherit',
            env: expect.objectContaining({
                HAPPY_RECONNECT_SESSION_ID: 'session-1',
                HAPPY_RECONNECT_ENCRYPTION_KEY: 'AQIDBA==',
                HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey',
                HAPPY_RECONNECT_SEQ: '42',
                HAPPY_RECONNECT_METADATA_VERSION: '7',
                HAPPY_RECONNECT_AGENT_STATE_VERSION: '9',
            }),
        });
    });

    it('does not fall back to legacy account credentials', async () => {
        mocks.mockResolveLocalReconnectableSession.mockRejectedValue(
            new LocalResumeSessionError('no local session material', 'not_found'),
        );

        await expect(handleResumeCommand(['missing'])).rejects.toThrow('no local session material');
        expect(spawnHappyCLI).not.toHaveBeenCalled();
    });
});
