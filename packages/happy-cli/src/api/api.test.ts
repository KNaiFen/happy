import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from './api';
import axios from 'axios';
import { connectionState } from '@/utils/serverConnectionErrors';

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
    decrypt: vi.fn((data: any) => data),
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
        currentCliVersion: '1.4.2',
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
            mockGet.mockResolvedValueOnce({
                data: {
                    codex: {
                        enabled: true,
                        protocolVersion: 4,
                        minimumHappyCliVersion: '1.4.2',
                        minimumHappyAppVersion: '1.11.4',
                        minimumCodexCliVersion: '0.145.0',
                    },
                },
            });

            await expect(api.isCodexSyncV4Enabled('0.145.0')).resolves.toBe(true);
            expect(mockGet).toHaveBeenCalledWith(
                expect.stringMatching(/\/v4\/capabilities$/),
                expect.objectContaining({
                    timeout: 10_000,
                    headers: expect.objectContaining({
                        'X-Happy-Client': expect.stringMatching(/^cli-coding-session\//),
                    }),
                }),
            );
        });

        it('retains v3 only when the server explicitly disables v4 or lacks the endpoint', async () => {
            mockGet.mockResolvedValueOnce({
                data: {
                    codex: {
                        enabled: false,
                        protocolVersion: 4,
                        minimumHappyCliVersion: '9.0.0',
                        minimumHappyAppVersion: '9.0.0',
                        minimumCodexCliVersion: '9.0.0',
                    },
                },
            }).mockRejectedValueOnce({ response: { status: 404 } });

            await expect(api.isCodexSyncV4Enabled('0.145.0')).resolves.toBe(false);
            await expect(api.isCodexSyncV4Enabled('0.145.0')).resolves.toBe(false);
        });

        it('blocks Codex startup when capabilities cannot be verified', async () => {
            mockGet
                .mockRejectedValueOnce({ code: 'ECONNREFUSED' })
                .mockResolvedValueOnce({ data: { codex: { enabled: 'yes' } } });

            await expect(api.isCodexSyncV4Enabled('0.145.0')).rejects.toThrow('unsafe v3 fallback');
            await expect(api.isCodexSyncV4Enabled('0.145.0')).rejects.toThrow('invalid Codex Sync v4 capability');
        });

        it('enforces the Happy CLI and Codex CLI versions advertised by the server', async () => {
            const capability = {
                codex: {
                    enabled: true,
                    protocolVersion: 4,
                    minimumHappyCliVersion: '1.4.2',
                    minimumHappyAppVersion: '1.11.4',
                    minimumCodexCliVersion: '0.146.0',
                },
            };
            mockGet.mockResolvedValue({ data: capability });

            await expect(api.isCodexSyncV4Enabled('0.145.0')).rejects.toThrow('Codex CLI 0.146.0 or newer');
        });
    });

    describe('getOrCreateSession', () => {
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

    describe('getOrCreateMachine', () => {
        it('should return minimal machine object when server is unreachable (ECONNREFUSED)', async () => {
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

            expect(result).toEqual({
                id: 'test-machine',
                encryptionKey: expect.any(Uint8Array),
                encryptionVariant: 'legacy',
                metadata: testMachineMetadata,
                metadataVersion: 0,
                daemonState: {
                    status: 'running',
                    pid: 1234
                },
                daemonStateVersion: 0,
            });

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return minimal machine object when server endpoint returns 404', async () => {
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

            expect(result).toEqual({
                id: 'test-machine',
                encryptionKey: expect.any(Uint8Array),
                encryptionVariant: 'legacy',
                metadata: testMachineMetadata,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            });

            // New unified format via connectionState.fail()
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Machine registration failed: 404')
            );

            consoleSpy.mockRestore();
        });
    });
});
