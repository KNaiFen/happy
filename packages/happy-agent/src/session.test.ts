import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    type CodexCommandResultEntityV4,
    type CodexEntityV4,
    type CodexRuntimeEntityV4,
    type CodexThreadEntityV4,
    type CodexTurnEntityV4,
    type SyncEntitySnapshotV4,
} from '@slopus/happy-wire';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    SessionClient,
    SyncV4Crypto,
    codexHistoryFromSnapshot,
    isCodexSnapshotIdle,
    type CodexV4Snapshot,
} from './session';

vi.mock('axios', () => ({
    default: {
        get: vi.fn(),
        post: vi.fn(),
        isAxiosError: vi.fn(() => false),
    },
}));

const mockedGet = vi.mocked(axios.get);
const mockedPost = vi.mocked(axios.post);
const sessionKey = new Uint8Array(32).fill(7);
const now = 1_700_000_000_000;

function thread(overrides: Partial<CodexThreadEntityV4> = {}): CodexThreadEntityV4 {
    return {
        schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
        entityType: 'codex.thread',
        providerId: 'thread-1',
        createdAt: now,
        updatedAt: now,
        threadId: 'thread-1',
        sessionTreeId: null,
        forkedFromThreadId: null,
        parentThreadId: null,
        name: null,
        preview: '',
        cwd: '/workspace',
        cliVersion: '0.145.0',
        model: null,
        modelProvider: 'openai',
        source: {},
        status: { type: 'idle' },
        canAcceptDirectInput: true,
        settings: {
            approvalPolicy: null,
            approvalsReviewer: null,
            sandboxPolicy: null,
            permissionProfile: null,
            serviceTier: null,
            reasoningEffort: null,
            reasoningSummary: null,
            collaborationMode: null,
            personality: null,
        },
        goal: null,
        tokenUsage: null,
        ...overrides,
    };
}

function runtime(overrides: Partial<CodexRuntimeEntityV4> = {}): CodexRuntimeEntityV4 {
    return {
        schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
        entityType: 'codex.runtime',
        providerId: 'runtime-1',
        createdAt: now,
        updatedAt: now,
        threadId: 'thread-1',
        connection: 'connected',
        execution: { type: 'idle' },
        statusUnknown: false,
        protocolVersion: 'stable-v2',
        codexCliVersion: '0.145.0',
        syncState: 'ready',
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        activeSubagentCount: 0,
        lastError: null,
        lastKnownAt: now,
        ...overrides,
    };
}

function turn(overrides: Partial<CodexTurnEntityV4> = {}): CodexTurnEntityV4 {
    return {
        schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
        entityType: 'codex.turn',
        providerId: 'turn-1',
        createdAt: now,
        updatedAt: now,
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'inProgress',
        startedAt: now,
        completedAt: null,
        durationMs: null,
        error: null,
        usage: null,
        planRevision: 0,
        diffRevision: 0,
        ...overrides,
    };
}

async function encryptedRecords(entities: CodexEntityV4[]): Promise<SyncEntitySnapshotV4[]> {
    const crypto = new SyncV4Crypto('session-1', sessionKey);
    return entities.map((entity, index) => {
        const entityId = crypto.opaqueEntityId(entity.entityType, entity.providerId);
        const revision = 1;
        const op = 'upsert' as const;
        return {
            producerId: 'gateway-1',
            entityId,
            entityType: entity.entityType,
            revision,
            op,
            ciphertext: crypto.encryptEntity({
                sessionId: 'session-1',
                entityId,
                entityType: entity.entityType,
                revision,
                op,
            }, entity),
            updatedSeq: index + 1,
            createdAt: now,
            updatedAt: now,
        };
    });
}

async function snapshotResponse(entities: CodexEntityV4[]) {
    return {
        data: {
            entities: await encryptedRecords(entities),
            highWatermark: entities.length,
            nextCursor: null,
        },
    };
}

function client(): SessionClient {
    return new SessionClient({
        sessionId: 'session-1',
        encryptionKey: sessionKey,
        token: 'token-1',
        serverUrl: 'https://happy.example',
        threadId: 'thread-1',
        pollIntervalMs: 1,
    });
}

function mockCapabilities(): void {
    mockedGet.mockResolvedValueOnce({
        data: {
            codex: {
                enabled: true,
                protocolVersion: 4,
                minimumHappyAgentVersion: '0.1.3',
            },
        },
    });
}

describe('SessionClient Codex Sync v4', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(axios.isAxiosError).mockReturnValue(false);
    });

    it('decrypts an authoritative snapshot without opening Socket.IO', async () => {
        mockCapabilities();
        mockedGet.mockResolvedValueOnce(await snapshotResponse([thread(), runtime()]));

        const snapshot = await client().readSnapshot();

        expect(snapshot.thread?.threadId).toBe('thread-1');
        expect(snapshot.runtime?.execution).toEqual({ type: 'idle' });
        expect(mockedGet).toHaveBeenCalledTimes(2);
        expect(mockedGet.mock.calls[1][0]).toContain('/v4/sessions/session-1/snapshot');
    });

    it('publishes turn.queue while the runtime is active', async () => {
        mockCapabilities();
        mockedGet.mockResolvedValueOnce(await snapshotResponse([
            thread({ status: { type: 'active', activeFlags: [] } }),
            runtime({ execution: { type: 'active', activeFlags: [] } }),
            turn(),
        ]));
        mockedPost.mockImplementationOnce(async (_url, body) => ({
            data: {
                acknowledgements: [{
                    mutationId: (body as { mutations: Array<{ mutationId: string }> }).mutations[0].mutationId,
                    seq: 4,
                    revision: 1,
                    status: 'accepted',
                }],
            },
        }));

        const published = await client().sendMessage('follow up');

        expect(published.command.command).toBe('turn.queue');
        expect(published.command.expectedTurnId).toBe('turn-1');
        expect((published.command as unknown as { queueEntryId?: string }).queueEntryId).toBeTruthy();
        expect(mockedPost.mock.calls[0][0]).toContain('/v4/sessions/session-1/mutations');
    });

    it('publishes turn.start when the reconciled snapshot is idle', async () => {
        mockCapabilities();
        mockedGet.mockResolvedValueOnce(await snapshotResponse([thread(), runtime()]));
        mockedPost.mockImplementationOnce(async (_url, body) => ({
            data: {
                acknowledgements: [{
                    mutationId: (body as { mutations: Array<{ mutationId: string }> }).mutations[0].mutationId,
                    seq: 3,
                    revision: 1,
                    status: 'accepted',
                }],
            },
        }));

        const published = await client().sendMessage('new turn');

        expect(published.command.command).toBe('turn.start');
        expect((published.command as unknown as { queueEntryId?: string | null }).queueEntryId).toBeNull();
    });

    it('rejects a mismatched mutation acknowledgement', async () => {
        mockCapabilities();
        mockedGet.mockResolvedValueOnce(await snapshotResponse([thread(), runtime()]));
        mockedPost.mockResolvedValueOnce({
            data: {
                acknowledgements: [{
                    mutationId: 'different-mutation',
                    seq: 3,
                    revision: 1,
                    status: 'accepted',
                }],
            },
        });

        await expect(client().sendMessage('new turn')).rejects.toThrow(
            'mismatched mutation acknowledgement',
        );
    });

    it('rejects a superseded command mutation', async () => {
        mockCapabilities();
        mockedGet.mockResolvedValueOnce(await snapshotResponse([thread(), runtime()]));
        mockedPost.mockImplementationOnce(async (_url, body) => ({
            data: {
                acknowledgements: [{
                    mutationId: (body as { mutations: Array<{ mutationId: string }> }).mutations[0].mutationId,
                    seq: 3,
                    revision: 1,
                    status: 'superseded',
                }],
            },
        }));

        await expect(client().sendMessage('new turn')).rejects.toThrow(
            'command mutation was superseded',
        );
    });

    it('waits for an authoritative command result', async () => {
        const result: CodexCommandResultEntityV4 = {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.commandResult',
            providerId: 'command-1',
            createdAt: now,
            updatedAt: now,
            commandId: 'command-1',
            threadId: 'thread-1',
            turnId: 'turn-1',
            status: 'succeeded',
            providerRequestId: null,
            result: null,
            error: null,
        };
        mockCapabilities();
        mockedGet.mockResolvedValueOnce(await snapshotResponse([thread(), runtime(), result]));

        await expect(client().waitForCommand('command-1', 50)).resolves.toMatchObject({
            status: 'succeeded',
        });
    });
});

describe('Codex snapshot projections', () => {
    it('never treats statusUnknown as idle', () => {
        const snapshot = {
            highWatermark: 1,
            entities: [],
            thread: thread(),
            runtime: runtime({ statusUnknown: true }),
            turns: [],
            items: [],
            parts: [],
            commandResults: [],
        } satisfies CodexV4Snapshot;
        expect(isCodexSnapshotIdle(snapshot)).toBe(false);
    });

    it('builds history only from official V4 parts', () => {
        const snapshot = {
            highWatermark: 2,
            entities: [],
            thread: thread(),
            runtime: runtime(),
            turns: [],
            items: [],
            parts: [{
                schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
                entityType: 'codex.part' as const,
                providerId: 'part-1',
                createdAt: now,
                updatedAt: now,
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'item-1',
                partId: 'part-1',
                kind: 'userInput' as const,
                index: 0,
                chunkIndex: 0,
                content: 'hello',
                contentType: 'text' as const,
                final: true,
            }],
            commandResults: [],
        } satisfies CodexV4Snapshot;

        expect(codexHistoryFromSnapshot(snapshot)).toEqual([
            expect.objectContaining({ role: 'user', text: 'hello' }),
        ]);
    });
});
