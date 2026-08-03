import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRandomBytes, randomUUID } from 'expo-crypto';
import {
    generateSyncV4MutationId,
    generateSyncV4TraceId,
    nativeSyncV4Entropy,
} from './syncV4Entropy';
import {
    AppSyncV4Client,
    type AppSyncV4Crypto,
    type AppSyncV4Transport,
} from './syncV4Client';
import {
    SyncV4Persistence,
    type SyncV4KeyValueStorage,
} from './syncV4Persistence';
import type {
    CodexEntityV4,
    SyncMutationBatchResponseV4,
    SyncMutationV4,
} from '@slopus/happy-wire';

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn(),
    randomUUID: vi.fn(),
}));

class MemoryStorage implements SyncV4KeyValueStorage {
    private readonly values = new Map<string, string | number | boolean>();

    getString(key: string) {
        const value = this.values.get(key);
        return typeof value === 'string' ? value : undefined;
    }

    getNumber(key: string) {
        const value = this.values.get(key);
        return typeof value === 'number' ? value : undefined;
    }

    set(key: string, value: string | number | boolean) {
        this.values.set(key, value);
    }

    delete(key: string) {
        this.values.delete(key);
    }

    getAllKeys() {
        return [...this.values.keys()];
    }
}

const fakeCrypto: AppSyncV4Crypto = {
    opaqueEntityId: async (entityType, providerId) => `opaque:${entityType}:${providerId}`,
    encryptEntity: async (_aad, entity) => JSON.stringify(entity),
    decryptEntity: async (_aad, ciphertext) => JSON.parse(ciphertext) as CodexEntityV4,
};

class FakeTransport implements AppSyncV4Transport {
    readonly posted: SyncMutationV4[][] = [];

    async getCapabilities() {
        return {
            codex: {
                enabled: true,
                protocolVersion: 4 as const,
                minimumHappyCliVersion: '1.4.7',
                minimumHappyAppVersion: '1.11.12',
                minimumHappyAgentVersion: '0.1.3',
                minimumCodexCliVersion: '0.145.0',
            },
        };
    }

    async postMutations(
        _sessionId: string,
        mutations: SyncMutationV4[],
    ): Promise<SyncMutationBatchResponseV4> {
        this.posted.push(mutations);
        return {
            acknowledgements: mutations.map((mutation, index) => ({
                mutationId: mutation.mutationId,
                seq: index + 1,
                revision: mutation.revision,
                status: 'accepted' as const,
            })),
        };
    }

    async getChanges(_sessionId: string, afterSeq: number) {
        return {
            changes: [],
            highWatermark: afterSeq,
            hasMore: false,
        };
    }

    async getSnapshot(): Promise<never> {
        throw new Error('snapshot not expected');
    }
}

describe('Sync v4 native entropy', () => {
    beforeEach(() => {
        vi.mocked(randomUUID).mockReset();
        vi.mocked(getRandomBytes).mockReset();
    });

    it('does not depend on the Web Crypto global', () => {
        const originalCrypto = globalThis.crypto;
        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: undefined,
        });
        vi.mocked(randomUUID).mockReturnValue('00000000-0000-4000-8000-000000000001');
        vi.mocked(getRandomBytes).mockReturnValue(Uint8Array.from([
            0x00, 0x01, 0x02, 0x03,
            0x04, 0x05, 0x06, 0x07,
            0x08, 0x09, 0x0a, 0x0b,
            0x0c, 0x0d, 0xfe, 0xff,
        ]));

        try {
            expect(generateSyncV4MutationId()).toBe(
                '00000000-0000-4000-8000-000000000001',
            );
            expect(generateSyncV4TraceId()).toBe(
                '000102030405060708090a0b0c0dfeff',
            );
            expect(getRandomBytes).toHaveBeenCalledWith(16);
        } finally {
            Object.defineProperty(globalThis, 'crypto', {
                configurable: true,
                value: originalCrypto,
            });
        }
    });

    it('starts the production v4 client and flushes its outbox without Web Crypto', async () => {
        const originalCrypto = globalThis.crypto;
        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: undefined,
        });
        vi.mocked(randomUUID).mockReturnValue('00000000-0000-4000-8000-000000000001');
        vi.mocked(getRandomBytes).mockReturnValue(new Uint8Array(16).fill(0x0a));
        const transport = new FakeTransport();
        const persistence = new SyncV4Persistence(
            new MemoryStorage(),
            generateSyncV4MutationId,
        );
        const client = await AppSyncV4Client.create({
            sessionId: 'session-1',
            sessionKey: new Uint8Array(32),
            appVersion: '1.11.12',
            persistence,
            transport,
            crypto: fakeCrypto,
            ...nativeSyncV4Entropy,
            onEntity: async () => undefined,
            onSnapshotReset: async () => undefined,
        });

        try {
            const mutation = await client.publishEntity({
                schemaVersion: 1,
                entityType: 'codex.command',
                providerId: 'command-1',
                createdAt: 1,
                updatedAt: 1,
                commandId: 'command-1',
                threadId: 'thread-1',
                expectedTurnId: null,
                command: 'turn.start',
                payload: { text: '你好' },
                clientUserMessageId: 'command-1',
                replacesCommandId: null,
            });
            await client.start();
            await client.flushOutboundOnce();

            expect(mutation.mutationId).toBe('00000000-0000-4000-8000-000000000001');
            expect(transport.posted.flat()).toContainEqual(
                expect.objectContaining({
                    mutationId: '00000000-0000-4000-8000-000000000001',
                    entityType: 'codex.command',
                }),
            );
        } finally {
            client.stop();
            Object.defineProperty(globalThis, 'crypto', {
                configurable: true,
                value: originalCrypto,
            });
        }
    });
});
