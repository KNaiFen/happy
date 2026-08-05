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
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    SessionClient,
    SyncV4Crypto,
    codexHistoryFromSnapshot,
    isCodexSnapshotIdle,
    type PublishedCodexCommand,
    type CodexV4Snapshot,
} from './session';
import { OperationReceiptStore } from './operationReceipts';

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

function commandResult(
    overrides: Partial<CodexCommandResultEntityV4> = {},
): CodexCommandResultEntityV4 {
    return {
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
        ...overrides,
    };
}

function publishedInterrupt(commandId = 'command-1'): PublishedCodexCommand {
    return {
        command: {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.command',
            providerId: commandId,
            createdAt: now,
            updatedAt: now,
            commandId,
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
            command: 'turn.interrupt',
            payload: { expectedTurnId: 'turn-1' },
            clientUserMessageId: commandId,
            replacesCommandId: null,
            queueEntryId: null,
        } as PublishedCodexCommand['command'],
        acknowledgement: {
            mutationId: 'mutation-1',
            seq: 1,
            revision: 1,
            status: 'accepted',
        } as PublishedCodexCommand['acknowledgement'],
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

function client(operationReceipts?: OperationReceiptStore): SessionClient {
    return new SessionClient({
        sessionId: 'session-1',
        encryptionKey: sessionKey,
        token: 'token-1',
        serverUrl: 'https://happy.example',
        threadId: 'thread-1',
        pollIntervalMs: 1,
        operationReceipts,
    });
}

function mockCapabilities(): void {
    mockedGet.mockResolvedValueOnce({
        data: {
            codex: {
                enabled: true,
                protocolVersion: 4,
                minimumHappyAgentVersion: '0.1.4',
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

    it('replays an exact persisted mutation after a lost response and process restart', async () => {
        const receiptDir = mkdtempSync(join(tmpdir(), 'happy-agent-session-receipts-'));
        try {
            mockCapabilities();
            mockedGet.mockResolvedValueOnce(await snapshotResponse([thread(), runtime()]));
            mockedPost.mockRejectedValue(new Error('lost mutation response'));
            vi.useFakeTimers();
            const firstAttempt = client(new OperationReceiptStore(receiptDir)).sendMessage('retry after restart');
            const rejection = expect(firstAttempt).rejects.toThrow('remains pending');
            await vi.runAllTimersAsync();
            await rejection;
            const firstBody = mockedPost.mock.calls[0][1];
            expect(mockedPost).toHaveBeenCalledTimes(5);
            const receiptFile = readdirSync(receiptDir).find((name) => name.endsWith('.json'));
            expect(receiptFile).toBeTruthy();
            expect(readFileSync(join(receiptDir, receiptFile!), 'utf8')).not.toContain(
                'retry after restart',
            );
            vi.useRealTimers();

            vi.resetAllMocks();
            vi.mocked(axios.isAxiosError).mockReturnValue(false);
            mockCapabilities();
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

            const published = await client(new OperationReceiptStore(receiptDir)).sendMessage(
                'retry after restart',
            );

            expect(mockedGet).toHaveBeenCalledTimes(1);
            expect(mockedPost).toHaveBeenCalledTimes(1);
            expect(mockedPost.mock.calls[0][1]).toEqual(firstBody);
            expect(published.command.commandId).toBe(
                (firstBody as { mutations: Array<{ mutationId: string }> }).mutations[0].mutationId,
            );
        } finally {
            vi.useRealTimers();
            rmSync(receiptDir, { recursive: true, force: true });
        }
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
        mockCapabilities();
        mockedGet.mockResolvedValueOnce(await snapshotResponse([thread(), runtime(), commandResult()]));

        await expect(client().waitForCommand('command-1', 50)).resolves.toMatchObject({
            status: 'succeeded',
        });
    });

    it('waits for authoritative idle after a command succeeds', async () => {
        mockCapabilities();
        mockedGet
            .mockResolvedValueOnce(await snapshotResponse([
                thread(),
                runtime(),
                commandResult(),
            ]))
            .mockResolvedValueOnce(await snapshotResponse([
                thread({ status: { type: 'active', activeFlags: [] } }),
                runtime({ execution: { type: 'active', activeFlags: [] } }),
                turn(),
                commandResult(),
            ]))
            .mockResolvedValueOnce(await snapshotResponse([
                thread(),
                runtime(),
                turn({ status: 'completed', completedAt: now + 1 }),
                commandResult(),
            ]));

        await expect(client().waitForCommandAndIdle('command-1', 50)).resolves.toMatchObject({
            runtime: expect.objectContaining({ execution: { type: 'idle' } }),
        });
        expect(mockedGet).toHaveBeenCalledTimes(4);
    });

    it('does not report stopped while the runtime state is unknown', async () => {
        mockCapabilities();
        mockedGet
            .mockResolvedValueOnce(await snapshotResponse([
                thread(),
                runtime({ statusUnknown: true }),
            ]))
            .mockResolvedValueOnce(await snapshotResponse([
                thread(),
                runtime({ statusUnknown: true }),
            ]))
            .mockResolvedValueOnce(await snapshotResponse([thread(), runtime()]));

        await expect(client().stopAndWait(50)).resolves.toMatchObject({
            runtime: expect.objectContaining({ statusUnknown: false }),
        });
        expect(mockedPost).not.toHaveBeenCalled();
        expect(mockedGet).toHaveBeenCalledTimes(4);
    });

    it('waits for the interrupted turn after its interrupt command succeeds', async () => {
        const session = client();
        vi.spyOn(session, 'sendStop').mockResolvedValue(publishedInterrupt());
        mockCapabilities();
        mockedGet
            .mockResolvedValueOnce(await snapshotResponse([
                thread(),
                runtime(),
                commandResult(),
            ]))
            .mockResolvedValueOnce(await snapshotResponse([
                thread({ status: { type: 'active', activeFlags: [] } }),
                runtime({ execution: { type: 'active', activeFlags: [] } }),
                turn(),
                commandResult(),
            ]))
            .mockResolvedValueOnce(await snapshotResponse([
                thread(),
                runtime(),
                turn({ status: 'interrupted', completedAt: now + 1 }),
                commandResult(),
            ]));

        await expect(session.stopAndWait(50)).resolves.toMatchObject({
            runtime: expect.objectContaining({ execution: { type: 'idle' } }),
        });
        expect(mockedGet).toHaveBeenCalledTimes(4);
    });

    it('keeps interrupt publication within the stop timeout budget', async () => {
        mockCapabilities();
        mockedGet.mockResolvedValueOnce(await snapshotResponse([
            thread({ status: { type: 'active', activeFlags: [] } }),
            runtime({ execution: { type: 'active', activeFlags: [] } }),
            turn(),
        ]));
        mockedPost.mockRejectedValue(new Error('lost mutation response'));

        await expect(client().stopAndWait(50)).rejects.toThrow(
            'Timeout publishing Codex command',
        );
        expect(mockedPost).toHaveBeenCalled();
        for (const call of mockedPost.mock.calls) {
            const requestTimeout = (call[2] as { timeout: number }).timeout;
            expect(requestTimeout).toBeGreaterThan(0);
            expect(requestTimeout).toBeLessThanOrEqual(50);
        }
    });

    it('allows a known idle session to stop without publishing an interrupt', async () => {
        mockCapabilities();
        mockedGet
            .mockResolvedValueOnce(await snapshotResponse([thread(), runtime()]))
            .mockResolvedValueOnce(await snapshotResponse([thread(), runtime()]));

        await expect(client().stopAndWait(50)).resolves.toMatchObject({
            runtime: expect.objectContaining({ execution: { type: 'idle' } }),
        });
        expect(mockedPost).not.toHaveBeenCalled();
        expect(mockedGet).toHaveBeenCalledTimes(3);
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
