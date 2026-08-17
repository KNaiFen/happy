import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient, SessionPresenceConflictError } from './api';
import axios from 'axios';
import { connectionState } from '@/utils/serverConnectionErrors';
import type { SyncV4DiagnosticInput } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const { mockGet, mockPost, mockIsAxiosError } = vi.hoisted(() => ({
    mockGet: vi.fn(),
    mockPost: vi.fn(),
    mockIsAxiosError: vi.fn(() => true)
}));

vi.mock('axios', () => ({
    default: {
        get: mockGet,
        post: mockPost,
        isAxiosError: mockIsAxiosError
    },
    isAxiosError: mockIsAxiosError
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

// Mock encryption utilities
vi.mock('./encryption', () => ({
    decodeBase64: vi.fn((data: string) => data),
    encodeBase64: vi.fn((data: any) => data),
    decrypt: vi.fn((_: any, __: any, data: any) => (
        typeof data === 'string' && data.startsWith('{') ? JSON.parse(data) : data
    )),
    encrypt: vi.fn((_: any, __: any, data: any) => data),
    libsodiumEncryptForPublicKey: vi.fn(() => new Uint8Array(48)),
    libsodiumPublicKeyFromSecretKey: vi.fn(() => new Uint8Array(32)),
    getRandomBytes: vi.fn((size: number) => new Uint8Array(size)),
}));

vi.mock('@/utils/deriveKey', () => ({
    deriveKey: vi.fn(async () => new Uint8Array(32)),
}));

// Mock configuration
vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://api.example.com',
        currentCliVersion: '1.4.7',
    }
}));

// Mock libsodium encryption
vi.mock('./libsodiumEncryption', () => ({
    libsodiumEncryptForPublicKey: vi.fn((data: any) => new Uint8Array(32))
}));

// Global test metadata
const testMetadata = {
    path: '/tmp',
    host: 'localhost',
    machineId: 'test-machine',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib',
    happyToolsDir: '/home/user/.happy/tools'
};

const testMachineMetadata = {
    host: 'localhost',
    platform: 'darwin',
    happyCliVersion: '1.0.0',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib'
};

describe('Api server error handling', () => {
    let api: ApiClient;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockGet.mockReset();
        mockPost.mockReset();
        mockIsAxiosError.mockReset();
        mockIsAxiosError.mockReturnValue(true);
        connectionState.reset(); // Reset offline state between tests

        // Create a mock credential
        const mockCredential = {
            token: 'fake-token',
            encryption: {
                type: 'legacy' as const,
                secret: new Uint8Array(32)
            }
        };

        api = await ApiClient.create(mockCredential);
    });

    describe('isCodexSyncV4Enabled', () => {
        it('uses v4 only when the server advertises the coordinated cutover', async () => {
            const diagnostics: SyncV4DiagnosticInput[] = [];
            mockGet.mockResolvedValueOnce({
                data: {
                    codex: {
                        enabled: true,
                        protocolVersion: 4,
                        minimumHappyCliVersion: '1.4.7',
                        minimumHappyAppVersion: '1.11.12',
                        minimumHappyAgentVersion: '0.1.3',
                        minimumCodexCliVersion: '0.147.0',
                    },
                },
                headers: { 'x-happy-sync-trace': '0123456789abcdef0123456789abcdef' },
            });

            const traceId = '0123456789abcdef0123456789abcdef';
            await expect(api.isCodexSyncV4Enabled(
                '0.147.0',
                traceId,
                { record: (input) => diagnostics.push(input) },
            )).resolves.toBe(true);
            expect(mockGet).toHaveBeenCalledWith(
                expect.stringMatching(/\/v4\/capabilities$/),
                expect.objectContaining({
                    timeout: 10_000,
                    headers: expect.objectContaining({
                        'X-Happy-Client': expect.stringMatching(/^cli-coding-session\//),
                        'X-Happy-Sync-Trace': traceId,
                    }),
                }),
            );
            expect(diagnostics).toEqual([
                expect.objectContaining({
                    event: 'transport',
                    phase: 'started',
                    traceId,
                }),
                expect.objectContaining({
                    event: 'transport',
                    phase: 'completed',
                    traceId,
                    state: 'ready',
                    featureEnabled: true,
                    transportSecurity: 'https',
                }),
            ]);
        });

        it('rejects an invalid capability trace ID before transport', async () => {
            await expect(api.isCodexSyncV4Enabled(
                '0.147.0',
                'prompt-reasoning-tool-output-secret',
            )).rejects.toThrow('128-bit lowercase hex');
            expect(mockGet).not.toHaveBeenCalled();
        });

        it('rejects startup when v4 is disabled or the endpoint is absent', async () => {
            const diagnostics: SyncV4DiagnosticInput[] = [];
            const sink = { record: (input: SyncV4DiagnosticInput) => diagnostics.push(input) };
            mockGet.mockResolvedValueOnce({
                data: {
                    codex: {
                        enabled: false,
                        protocolVersion: 4,
                        minimumHappyCliVersion: '9.0.0',
                        minimumHappyAppVersion: '9.0.0',
                        minimumHappyAgentVersion: '0.1.3',
                        minimumCodexCliVersion: '9.0.0',
                    },
                },
                headers: { 'x-happy-sync-trace': '00000000000000000000000000000001' },
            }).mockRejectedValueOnce({ response: { status: 404 } });

            await expect(api.isCodexSyncV4Enabled(
                '0.147.0',
                '00000000000000000000000000000001',
                sink,
            )).rejects.toThrow('Codex Sync v4 disabled');
            await expect(api.isCodexSyncV4Enabled(
                '0.147.0',
                '00000000000000000000000000000002',
                sink,
            )).rejects.toThrow('required Codex Sync v4 capability endpoint');
            expect(diagnostics.filter((record) => record.phase === 'failed')).toEqual([
                expect.objectContaining({
                    traceId: '00000000000000000000000000000001',
                    httpStatus: 200,
                    featureEnabled: false,
                    errorKind: 'protocol',
                }),
                expect.objectContaining({
                    traceId: '00000000000000000000000000000002',
                    httpStatus: 404,
                    featureEnabled: false,
                    errorKind: 'protocol',
                }),
            ]);
        });

        it('blocks Codex startup when capabilities cannot be verified', async () => {
            const diagnostics: SyncV4DiagnosticInput[] = [];
            const sink = { record: (input: SyncV4DiagnosticInput) => diagnostics.push(input) };
            mockGet
                .mockRejectedValueOnce({ code: 'ECONNREFUSED' })
                .mockResolvedValueOnce({
                    data: { codex: { enabled: 'yes' } },
                    headers: { 'x-happy-sync-trace': '00000000000000000000000000000004' },
                });

            await expect(api.isCodexSyncV4Enabled(
                '0.147.0',
                '00000000000000000000000000000003',
                sink,
            )).rejects.toThrow('Codex Sync v4 is required');
            await expect(api.isCodexSyncV4Enabled(
                '0.147.0',
                '00000000000000000000000000000004',
                sink,
            )).rejects.toThrow('invalid Codex Sync v4 capability');
            expect(diagnostics.filter((record) => record.phase === 'failed')).toEqual([
                expect.objectContaining({
                    traceId: '00000000000000000000000000000003',
                    errorKind: 'network',
                }),
                expect.objectContaining({
                    traceId: '00000000000000000000000000000004',
                    errorKind: 'validation',
                }),
            ]);
        });

        it('does not let hostile Axios response getters escape the capability boundary', async () => {
            const diagnostics: SyncV4DiagnosticInput[] = [];
            const secret = 'prompt-reasoning-tool-output-getter-secret';
            const hostileError = Object.defineProperty({}, 'response', {
                get: () => {
                    throw new Error(secret);
                },
            });
            mockGet.mockRejectedValueOnce(hostileError);

            await expect(api.isCodexSyncV4Enabled(
                '0.147.0',
                '00000000000000000000000000000005',
                { record: (input) => diagnostics.push(input) },
            )).rejects.toThrow('Codex Sync v4 is required');

            expect(JSON.stringify(diagnostics)).not.toContain(secret);
            expect(diagnostics.at(-1)).toMatchObject({
                phase: 'failed',
                errorKind: 'unknown',
            });
        });

        it('rejects a missing or mismatched capability trace echo', async () => {
            const diagnostics: SyncV4DiagnosticInput[] = [];
            const capability = {
                codex: {
                    enabled: true,
                    protocolVersion: 4,
                    minimumHappyCliVersion: '1.4.7',
                    minimumHappyAppVersion: '1.11.12',
                    minimumHappyAgentVersion: '0.1.3',
                    minimumCodexCliVersion: '0.147.0',
                },
            };
            mockGet
                .mockResolvedValueOnce({ data: capability, headers: {} })
                .mockResolvedValueOnce({
                    data: capability,
                    headers: { 'x-happy-sync-trace': 'f'.repeat(32) },
                });

            await expect(api.isCodexSyncV4Enabled(
                '0.147.0',
                'a'.repeat(32),
                { record: (input) => diagnostics.push(input) },
            )).rejects.toThrow('could not be correlated');
            await expect(api.isCodexSyncV4Enabled(
                '0.147.0',
                'b'.repeat(32),
                { record: (input) => diagnostics.push(input) },
            )).rejects.toThrow('could not be correlated');

            expect(diagnostics.filter((record) => record.phase === 'failed')).toEqual([
                expect.objectContaining({ traceId: 'a'.repeat(32), errorKind: 'protocol' }),
                expect.objectContaining({ traceId: 'b'.repeat(32), errorKind: 'protocol' }),
            ]);
        });

        it('enforces the Happy CLI and Codex CLI versions advertised by the server', async () => {
            const capability = {
                codex: {
                    enabled: true,
                    protocolVersion: 4,
                    minimumHappyCliVersion: '1.4.7',
                    minimumHappyAppVersion: '1.11.12',
                    minimumHappyAgentVersion: '0.1.3',
                    minimumCodexCliVersion: '0.148.0',
                },
            };
            mockGet.mockResolvedValue({ data: capability });

            await expect(api.isCodexSyncV4Enabled('0.147.0')).rejects.toThrow('Codex CLI 0.148.0 or newer');
        });
    });

    describe('getOrCreateSession', () => {
        it('does not log raw session identity, tag, or transport errors', async () => {
            const sessionId = 'provider-session-id-secret';
            const tag = 'provider-session-tag-secret';
            mockPost.mockResolvedValueOnce({
                data: {
                    session: {
                        id: sessionId,
                        seq: 0,
                        metadata: testMetadata,
                        metadataVersion: 0,
                        agentState: null,
                        agentStateVersion: 0,
                    },
                },
            });
            await api.getOrCreateSession({
                tag,
                metadata: testMetadata,
                state: null,
            });

            const transportSecret = 'prompt-reasoning-tool-output-transport-secret';
            const authorizationSecret = 'Bearer authorization-secret';
            mockPost.mockRejectedValueOnce(Object.assign(new Error(transportSecret), {
                code: 'UNAUTHORIZED',
                config: { headers: { Authorization: authorizationSecret } },
            }));
            await expect(api.getOrCreateSession({
                tag,
                metadata: testMetadata,
                state: null,
            })).rejects.toThrow(transportSecret);

            const logs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
            expect(logs).not.toContain(sessionId);
            expect(logs).not.toContain(tag);
            expect(logs).not.toContain(transportSecret);
            expect(logs).not.toContain(authorizationSecret);
            expect(logs).toContain('sessionHash');
            expect(logs).toContain('errorKind');
        });

        it('uses a caller-provided independent data key for a recoverable child session', async () => {
            const childKey = new Uint8Array(32).fill(7);
            mockPost.mockResolvedValue({
                data: {
                    session: {
                        id: 'child-session',
                        seq: 0,
                        metadata: testMetadata,
                        metadataVersion: 0,
                        agentState: null,
                        agentStateVersion: 0,
                    },
                },
            });

            const result = await api.getOrCreateSession({
                tag: 'opaque-child-tag',
                metadata: testMetadata,
                state: null,
                dataEncryptionKey: childKey,
            });

            expect(result).toMatchObject({
                id: 'child-session',
                encryptionVariant: 'dataKey',
                encryptionKey: childKey,
            });
            expect(mockPost).toHaveBeenCalledWith(
                expect.stringContaining('/v1/sessions'),
                expect.objectContaining({
                    tag: 'opaque-child-tag',
                    dataEncryptionKey: expect.any(Uint8Array),
                    machineId: 'test-machine',
                }),
                expect.anything(),
            );
        });

        it('should return null when Happy server is unreachable (ECONNREFUSED)', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when Happy server cannot be found (ENOTFOUND)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw DNS resolution error
            mockPost.mockRejectedValue({ code: 'ENOTFOUND' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when Happy server times out (ETIMEDOUT)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw timeout error
            mockPost.mockRejectedValue({ code: 'ETIMEDOUT' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('treats an axios ECONNABORTED deadline as an offline retry', async () => {
            connectionState.reset();
            mockPost.mockRejectedValue({ code: 'ECONNABORTED' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null,
                timeoutMs: 1_500,
            });

            expect(result).toBeNull();
            expect(mockPost).toHaveBeenCalledWith(
                expect.stringContaining('/v1/sessions'),
                expect.anything(),
                expect.objectContaining({ timeout: 1_500 }),
            );
        });

        it('should return null when session endpoint returns 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            // New unified format via connectionState.fail()
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Session creation failed: 404')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when server returns 500 Internal Server Error', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 500 error
            mockPost.mockRejectedValue({
                response: { status: 500 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            consoleSpy.mockRestore();
        });

        it('should return null when server returns 503 Service Unavailable', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 503 error
            mockPost.mockRejectedValue({
                response: { status: 503 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            consoleSpy.mockRestore();
        });

        it('rejects 401 with the relay-specific login recovery command', async () => {
            mockPost.mockRejectedValue({
                response: { status: 401 },
                isAxiosError: true,
            });

            await expect(api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null,
            })).rejects.toThrow('happy auth login --force');
        });

        it('should re-throw non-connection errors', async () => {
            // Mock axios to throw a different type of error (e.g., authentication error)
            const authError = new Error('Invalid API key');
            (authError as any).code = 'UNAUTHORIZED';
            mockPost.mockRejectedValue(authError);

            await expect(
                api.getOrCreateSession({ tag: 'test-tag', metadata: testMetadata, state: null })
            ).rejects.toThrow('Failed to get or create session: Invalid API key');

            // Should not show the offline mode message
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            expect(consoleSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            consoleSpy.mockRestore();
        });
    });

    describe('getMachineSessionSnapshot', () => {
        const sessionRow = (id: string) => ({
            id,
            seq: 0,
            metadata: JSON.stringify(testMetadata),
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: 'wrapped-key',
            active: false,
            originMachineId: 'test-machine',
            machineDeletedAt: null,
        });

        it('finds and decrypts a machine session beyond the first page', async () => {
            mockGet
                .mockResolvedValueOnce({
                    data: {
                        sessions: Array.from({ length: 200 }, (_, index) => sessionRow(`other-${index}`)),
                        nextCursor: 'cursor-2',
                        hasNext: true,
                    },
                })
                .mockResolvedValueOnce({
                    data: {
                        sessions: [{
                            id: 'session-target',
                            seq: 42,
                            metadata: JSON.stringify(testMetadata),
                            metadataVersion: 7,
                            agentState: JSON.stringify({}),
                            agentStateVersion: 9,
                            dataEncryptionKey: 'wrapped-key',
                            active: false,
                            originMachineId: 'test-machine',
                            machineDeletedAt: null,
                        }],
                        nextCursor: null,
                        hasNext: false,
                    },
                });
            const encryptionKey = new Uint8Array(32).fill(7);

            const snapshot = await api.getMachineSessionSnapshot({
                sessionId: 'session-target',
                machineId: 'test-machine',
                encryptionKey,
                encryptionVariant: 'dataKey',
            });

            expect(snapshot).toMatchObject({
                id: 'session-target',
                seq: 42,
                metadata: testMetadata,
                metadataVersion: 7,
                agentStateVersion: 9,
                active: false,
                originMachineId: 'test-machine',
                machineDeletedAt: null,
                hasIndependentDataKey: true,
                encryptionVariant: 'dataKey',
            });
            expect(snapshot?.encryptionKey).toEqual(encryptionKey);
            expect(mockGet).toHaveBeenNthCalledWith(
                1,
                'https://api.example.com/v2/sessions?limit=200&originMachineId=test-machine',
                expect.objectContaining({
                    headers: expect.objectContaining({ Authorization: 'Bearer fake-token' }),
                }),
            );
            expect(mockGet).toHaveBeenNthCalledWith(
                2,
                'https://api.example.com/v2/sessions?limit=200&originMachineId=test-machine&cursor=cursor-2',
                expect.anything(),
            );
        });

        it('rejects a repeated relay cursor instead of looping forever', async () => {
            mockGet
                .mockResolvedValueOnce({
                    data: { sessions: [], nextCursor: 'same', hasNext: true },
                })
                .mockResolvedValueOnce({
                    data: { sessions: [], nextCursor: 'same', hasNext: true },
                });

            await expect(api.getMachineSessionSnapshot({
                sessionId: 'missing',
                machineId: 'test-machine',
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'dataKey',
            })).rejects.toThrow('repeated cursor');
        });

        it('rejects malformed relay pages before decrypting them', async () => {
            mockGet.mockResolvedValueOnce({
                data: { sessions: [{ id: 'incomplete' }], nextCursor: null, hasNext: false },
            });

            await expect(api.getMachineSessionSnapshot({
                sessionId: 'incomplete',
                machineId: 'test-machine',
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'dataKey',
            })).rejects.toThrow('invalid page');
        });
    });

    describe('unarchiveSession', () => {
        it('restores the original session with terminal credentials', async () => {
            mockPost.mockResolvedValueOnce({ data: { success: true } });

            await expect(api.unarchiveSession('session/original')).resolves.toBe(true);
            expect(mockPost).toHaveBeenCalledWith(
                'https://api.example.com/v4/sessions/session%2Foriginal/unarchive',
                {},
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer fake-token',
                    }),
                }),
            );
        });

        it('keeps retrying the original session while the relay is offline', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            mockPost.mockRejectedValueOnce({ code: 'ECONNREFUSED' });

            await expect(api.unarchiveSession('session-1')).resolves.toBe(false);
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Session unarchive'),
            );
            consoleSpy.mockRestore();
        });

        it('uses a bounded Gateway deadline without treating it as a rejection', async () => {
            mockPost.mockRejectedValueOnce({ code: 'ECONNABORTED' });

            await expect(api.unarchiveSession('session-1', 1_500)).resolves.toBe(false);
            expect(mockPost).toHaveBeenCalledWith(
                expect.stringContaining('/v4/sessions/session-1/unarchive'),
                {},
                expect.objectContaining({ timeout: 1_500 }),
            );
        });

        it('does not hide an ownership rejection as an offline retry', async () => {
            mockPost.mockRejectedValueOnce({
                response: { status: 403 },
                isAxiosError: true,
            });

            await expect(api.unarchiveSession('session-1'))
                .rejects.toThrow('Failed to unarchive session (403)');
        });
    });

    describe('archiveSessionV4', () => {
        it('writes the authoritative v4 tombstone with terminal credentials', async () => {
            mockPost.mockResolvedValueOnce({ status: 200, data: { success: true } });

            await expect(api.archiveSessionV4('session/original')).resolves.toBe(true);
            expect(mockPost).toHaveBeenCalledWith(
                'https://api.example.com/v4/sessions/session%2Foriginal/archive',
                {},
                expect.objectContaining({
                    headers: expect.objectContaining({ Authorization: 'Bearer fake-token' }),
                }),
            );
        });

        it('keeps retirement pending while the relay is unavailable', async () => {
            mockPost.mockRejectedValueOnce({ code: 'ECONNRESET' });

            await expect(api.archiveSessionV4('session-1')).resolves.toBe(false);
        });

        it('surfaces an ownership rejection instead of releasing the thread lease', async () => {
            mockPost.mockRejectedValueOnce({
                response: { status: 403 },
                isAxiosError: true,
            });

            await expect(api.archiveSessionV4('session-1'))
                .rejects.toThrow('Failed to archive Codex session (403)');
        });
    });

    describe('session presence leases', () => {
        it('claims, touches, and releases the encoded Session with machine credentials', async () => {
            mockPost.mockResolvedValue({ status: 200, data: { success: true } });

            await expect(api.claimSessionPresence('session/original', 'lease-1', 1_500))
                .resolves.toBe(true);
            await expect(api.touchSessionPresence('session/original', 'lease-1', 1_500))
                .resolves.toBe(true);
            await expect(api.releaseSessionPresence('session/original', 'lease-1', 1_500))
                .resolves.toBe(true);

            expect(mockPost).toHaveBeenNthCalledWith(
                1,
                'https://api.example.com/v4/sessions/session%2Foriginal/presence/claim',
                { leaseId: 'lease-1' },
                expect.objectContaining({ timeout: 1_500 }),
            );
            expect(mockPost).toHaveBeenNthCalledWith(
                2,
                'https://api.example.com/v4/sessions/session%2Foriginal/presence/touch',
                { leaseId: 'lease-1' },
                expect.any(Object),
            );
            expect(mockPost).toHaveBeenNthCalledWith(
                3,
                'https://api.example.com/v4/sessions/session%2Foriginal/presence/release',
                { leaseId: 'lease-1' },
                expect.any(Object),
            );
        });

        it('surfaces tombstones and superseded leases as typed conflicts', async () => {
            mockPost.mockRejectedValueOnce({
                response: { status: 409, data: { error: 'sessionArchived' } },
            });
            await expect(api.touchSessionPresence('session-1', 'lease-1'))
                .rejects.toEqual(new SessionPresenceConflictError('sessionArchived'));

            mockPost.mockRejectedValueOnce({
                response: { status: 409, data: { error: 'presenceLeaseSuperseded' } },
            });
            await expect(api.releaseSessionPresence('session-1', 'lease-1'))
                .rejects.toMatchObject({ reason: 'presenceLeaseSuperseded' });
        });

        it('keeps a lease retryable when the relay is temporarily unavailable', async () => {
            mockPost.mockRejectedValueOnce({ code: 'ECONNRESET' });

            await expect(api.touchSessionPresence('session-1', 'lease-1')).resolves.toBe(false);
        });
    });

    describe('getOrCreateMachine', () => {
        it('returns pending instead of inventing a registered machine when the relay is unreachable', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                daemonState: {
                    status: 'running',
                    pid: 1234
                }
            });

            expect(result).toBeNull();

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('returns pending instead of inventing a registered machine on 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404 },
                isAxiosError: true
            });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            });

            expect(result).toBeNull();

            // New unified format via connectionState.fail()
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Machine registration failed: 404')
            );

            consoleSpy.mockRestore();
        });

        it('returns pending on a relay 5xx response', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            mockPost.mockRejectedValue({
                response: { status: 500 },
                isAxiosError: true,
            });

            await expect(api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
            })).resolves.toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Machine registration failed: 500'),
            );
            consoleSpy.mockRestore();
        });

        it('rejects 401 with the relay-specific login recovery command', async () => {
            mockPost.mockRejectedValue({
                response: { status: 401 },
                isAxiosError: true,
            });

            await expect(api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
            })).rejects.toThrow('happy auth login --force');
        });
    });

    describe('vendor token logging', () => {
        it('does not log response or parsed token field names', async () => {
            const responseFieldSecret = 'response-field-prompt-secret';
            const tokenFieldSecret = 'token-field-reasoning-secret';
            mockGet.mockResolvedValueOnce({
                status: 200,
                data: {
                    token: JSON.stringify({ [tokenFieldSecret]: 'tool-output-secret' }),
                    [responseFieldSecret]: true,
                },
            });

            await expect(api.getVendorToken('openai')).resolves.toEqual({
                [tokenFieldSecret]: 'tool-output-secret',
            });

            const logs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
            expect(logs).not.toContain(responseFieldSecret);
            expect(logs).not.toContain(tokenFieldSecret);
            expect(logs).not.toContain('tool-output-secret');
        });
    });
});
