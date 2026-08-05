import {
    CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
    CodexEntityV4Schema,
    SyncMutationBatchResponseV4Schema,
    SyncMutationBatchV4Schema,
    SyncSnapshotResponseV4Schema,
    encodeSyncV4Aad,
    encodeSyncV4OpaqueEntityIdInput,
    isSyncV4VersionAtLeast,
    type CodexCommandEntityV4,
    type CodexCommandResultEntityV4,
    type CodexEntityType,
    type CodexEntityV4,
    type CodexItemEntityV4,
    type CodexPartEntityV4,
    type CodexRuntimeEntityV4,
    type CodexThreadEntityV4,
    type CodexTurnEntityV4,
    type SyncMutationOperationV4,
    type SyncMutationV4,
    type SyncV4Aad,
} from '@slopus/happy-wire';
import axios from 'axios';
import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    randomUUID,
} from 'node:crypto';
import { HAPPY_AGENT_CLIENT_HEADER, HAPPY_AGENT_VERSION } from './clientVersion';
import {
    decodeBase64,
    deriveKey,
    encodeBase64,
    encodeBase64Url,
    hmac_sha512,
} from './encryption';

const SNAPSHOT_PAGE_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const SYNC_V4_CIPHERTEXT_VERSION = 1;
const SYNC_V4_NONCE_BYTES = 12;
const SYNC_V4_AUTH_TAG_BYTES = 16;

type JsonValue = CodexCommandEntityV4['payload'];

export interface SessionClientOptions {
    sessionId: string;
    encryptionKey: Uint8Array;
    token: string;
    serverUrl: string;
    threadId?: string | null;
    machineId?: string | null;
    pollIntervalMs?: number;
}

export interface CodexV4Snapshot {
    highWatermark: number;
    entities: CodexEntityV4[];
    thread: CodexThreadEntityV4 | null;
    runtime: CodexRuntimeEntityV4 | null;
    turns: CodexTurnEntityV4[];
    items: CodexItemEntityV4[];
    parts: CodexPartEntityV4[];
    commandResults: CodexCommandResultEntityV4[];
}

export interface CodexV4HistoryEntry {
    id: string;
    createdAt: number;
    role: 'user' | 'assistant' | 'tool';
    text: string;
    turnId: string;
    itemId: string;
    kind: CodexPartEntityV4['kind'];
}

export interface PublishedCodexCommand {
    command: CodexCommandEntityV4;
    acknowledgement: ReturnType<typeof SyncMutationBatchResponseV4Schema.parse>['acknowledgements'][number];
}

interface CommandDraft {
    command: 'turn.start' | 'turn.queue' | 'turn.interrupt';
    threadId: string;
    expectedTurnId: string | null;
    payload: JsonValue;
    queueEntryId?: string;
    bindingGeneration?: number;
}

class SyncV4ProtocolError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SyncV4ProtocolError';
    }
}

export class SyncV4Crypto {
    private readonly entityIdKey: Uint8Array;
    private readonly entityAeadKey: Uint8Array;

    constructor(
        private readonly sessionId: string,
        sessionKey: Uint8Array,
    ) {
        if (sessionKey.length !== 32) {
            throw new Error('Codex Sync v4 requires a 32-byte session key');
        }
        const rootKey = deriveKey(sessionKey, 'Happy Sync v4', [sessionId]);
        this.entityIdKey = deriveKey(rootKey, 'Happy Sync v4 Entity IDs', ['hmac']);
        this.entityAeadKey = deriveKey(rootKey, 'Happy Sync v4 Entities', ['aead']);
    }

    opaqueEntityId(entityType: CodexEntityType, providerId: string): string {
        const input = new TextEncoder().encode(
            encodeSyncV4OpaqueEntityIdInput(entityType, providerId),
        );
        return encodeBase64Url(hmac_sha512(this.entityIdKey, input).slice(0, 32));
    }

    encryptEntity(aad: SyncV4Aad, entity: CodexEntityV4): string {
        this.assertEntityIdentity(aad, entity);
        const nonce = new Uint8Array(randomBytes(SYNC_V4_NONCE_BYTES));
        const plaintext = Buffer.from(JSON.stringify(entity), 'utf8');
        const cipher = createCipheriv('chacha20-poly1305', this.entityAeadKey, nonce, {
            authTagLength: SYNC_V4_AUTH_TAG_BYTES,
        });
        cipher.setAAD(Buffer.from(encodeSyncV4Aad(aad), 'utf8'), {
            plaintextLength: plaintext.length,
        });
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const authTag = cipher.getAuthTag();
        const bundle = new Uint8Array(1 + nonce.length + ciphertext.length + authTag.length);
        bundle[0] = SYNC_V4_CIPHERTEXT_VERSION;
        bundle.set(nonce, 1);
        bundle.set(ciphertext, 1 + nonce.length);
        bundle.set(authTag, 1 + nonce.length + ciphertext.length);
        return encodeBase64(bundle);
    }

    decryptEntity(aad: SyncV4Aad, encodedCiphertext: string): CodexEntityV4 {
        try {
            const bundle = decodeBase64(encodedCiphertext);
            if (
                bundle.length < 1 + SYNC_V4_NONCE_BYTES + SYNC_V4_AUTH_TAG_BYTES
                || bundle[0] !== SYNC_V4_CIPHERTEXT_VERSION
            ) {
                throw new Error('invalid ciphertext');
            }
            const nonce = bundle.slice(1, 1 + SYNC_V4_NONCE_BYTES);
            const authTag = bundle.slice(bundle.length - SYNC_V4_AUTH_TAG_BYTES);
            const ciphertext = bundle.slice(
                1 + SYNC_V4_NONCE_BYTES,
                bundle.length - SYNC_V4_AUTH_TAG_BYTES,
            );
            const decipher = createDecipheriv(
                'chacha20-poly1305',
                this.entityAeadKey,
                nonce,
                { authTagLength: SYNC_V4_AUTH_TAG_BYTES },
            );
            decipher.setAAD(Buffer.from(encodeSyncV4Aad(aad), 'utf8'), {
                plaintextLength: ciphertext.length,
            });
            decipher.setAuthTag(authTag);
            const plaintext = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final(),
            ]).toString('utf8');
            const entity = CodexEntityV4Schema.parse(JSON.parse(plaintext));
            this.assertEntityIdentity(aad, entity);
            return entity;
        } catch {
            throw new Error('Unable to authenticate Codex Sync v4 entity');
        }
    }

    private assertEntityIdentity(aad: SyncV4Aad, entity: CodexEntityV4): void {
        if (aad.sessionId !== this.sessionId || aad.entityType !== entity.entityType) {
            throw new Error('Codex Sync v4 entity identity mismatch');
        }
        if (this.opaqueEntityId(entity.entityType, entity.providerId) !== aad.entityId) {
            throw new Error('Codex Sync v4 opaque entity ID mismatch');
        }
    }
}

export class SessionClient {
    readonly sessionId: string;
    private readonly crypto: SyncV4Crypto;
    private readonly serverUrl: string;
    private readonly token: string;
    private readonly preferredThreadId: string | null;
    private readonly machineId: string | null;
    private readonly pollIntervalMs: number;
    private capabilitiesChecked = false;

    constructor(opts: SessionClientOptions) {
        this.sessionId = opts.sessionId;
        this.crypto = new SyncV4Crypto(opts.sessionId, opts.encryptionKey);
        this.serverUrl = opts.serverUrl.replace(/\/$/, '');
        this.token = opts.token;
        this.preferredThreadId = nonEmptyString(opts.threadId);
        this.machineId = nonEmptyString(opts.machineId);
        this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    }

    async readSnapshot(timeoutMs?: number): Promise<CodexV4Snapshot> {
        const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
        await this.assertCompatible(deadline === null
            ? undefined
            : Math.min(30_000, this.snapshotRequestTimeout(deadline)));
        let cursor: string | null = null;
        let highWatermark: number | null = null;
        const entities: CodexEntityV4[] = [];

        do {
            const response = await axios.get(
                `${this.serverUrl}/v4/sessions/${encodeURIComponent(this.sessionId)}/snapshot`,
                {
                    params: { ...(cursor ? { cursor } : {}), limit: SNAPSHOT_PAGE_SIZE },
                    headers: this.headers(),
                    timeout: this.snapshotRequestTimeout(deadline),
                },
            );
            const page = SyncSnapshotResponseV4Schema.parse(response.data);
            if (highWatermark !== null && page.highWatermark !== highWatermark) {
                throw new Error('Codex Sync v4 snapshot watermark changed across pages');
            }
            highWatermark = page.highWatermark;
            for (const record of page.entities) {
                if (record.op === 'delete') continue;
                entities.push(this.crypto.decryptEntity({
                    sessionId: this.sessionId,
                    entityId: record.entityId,
                    entityType: record.entityType,
                    revision: record.revision,
                    op: record.op,
                }, record.ciphertext));
            }
            cursor = page.nextCursor;
        } while (cursor);

        return projectSnapshot(
            highWatermark ?? 0,
            entities,
            this.preferredThreadId,
        );
    }

    async sendMessage(
        text: string,
        options: { permissionMode?: string } = {},
    ): Promise<PublishedCodexCommand> {
        if (text.trim().length === 0) throw new Error('Message must not be empty');
        const snapshot = await this.readSnapshot();
        const threadId = snapshot.thread?.threadId ?? this.preferredThreadId;
        if (!threadId) throw new Error('Codex thread identity is unavailable');
        const activeTurn = latestEntity(snapshot.turns.filter((turn) => (
            turn.threadId === threadId && turn.status === 'inProgress'
        )));
        const runtimeActive = snapshot.runtime?.execution.type === 'active';
        const command = activeTurn || runtimeActive ? 'turn.queue' : 'turn.start';
        return await this.publishCommand({
            command,
            threadId,
            expectedTurnId: activeTurn?.turnId ?? null,
            payload: {
                text,
                displayText: text,
                ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
            },
            ...(command === 'turn.queue' ? { queueEntryId: randomUUID() } : {}),
            ...bindingGeneration(snapshot.runtime),
        });
    }

    async sendStop(timeoutMs?: number): Promise<PublishedCodexCommand | null> {
        const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
        const snapshot = await this.readSnapshot(deadline === null
            ? undefined
            : this.remainingTimeout(deadline));
        const threadId = snapshot.thread?.threadId ?? this.preferredThreadId;
        if (!threadId) throw new Error('Codex thread identity is unavailable');
        const activeTurn = latestEntity(snapshot.turns.filter((turn) => (
            turn.threadId === threadId && turn.status === 'inProgress'
        )));
        if (!activeTurn) return null;
        return await this.publishCommand({
            command: 'turn.interrupt',
            threadId,
            expectedTurnId: activeTurn.turnId,
            payload: { expectedTurnId: activeTurn.turnId },
            ...bindingGeneration(snapshot.runtime),
        }, deadline === null ? undefined : this.remainingTimeout(deadline));
    }

    async waitForCommand(commandId: string, timeoutMs = 300_000): Promise<CodexCommandResultEntityV4> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const snapshot = await this.readSnapshot(this.remainingTimeout(deadline));
            const result = latestEntity(snapshot.commandResults.filter((candidate) => (
                candidate.commandId === commandId
            )));
            if (result?.status === 'succeeded') return result;
            if (result && !['received', 'executing'].includes(result.status)) {
                throw new Error(result.error ?? `Codex command ended with status ${result.status}`);
            }
            if (!await this.delayUntil(deadline)) break;
        }
        throw new Error('Timeout waiting for Codex command completion');
    }

    async waitForCommandAndIdle(commandId: string, timeoutMs = 300_000): Promise<CodexV4Snapshot> {
        const deadline = Date.now() + timeoutMs;
        let targetTurnId: string | null = null;
        while (Date.now() < deadline) {
            const snapshot = await this.readSnapshot(this.remainingTimeout(deadline));
            const result = latestEntity(snapshot.commandResults.filter((candidate) => (
                candidate.commandId === commandId
            )));
            if (result?.status === 'succeeded') {
                if (!result.turnId) {
                    throw new Error('Codex turn command succeeded without a turn ID');
                }
                targetTurnId = result.turnId;
            }
            if (result && !['received', 'executing', 'succeeded'].includes(result.status)) {
                throw new Error(result.error ?? `Codex command ended with status ${result.status}`);
            }
            const targetTurn = targetTurnId
                ? latestEntity(snapshot.turns.filter((turn) => turn.turnId === targetTurnId))
                : null;
            if (targetTurn && isCodexTurnTerminal(targetTurn) && isCodexSnapshotIdle(snapshot)) {
                return snapshot;
            }
            if (!await this.delayUntil(deadline)) break;
        }
        throw new Error('Timeout waiting for Codex command completion and idle state');
    }

    async stopAndWait(timeoutMs = 300_000): Promise<CodexV4Snapshot> {
        const deadline = Date.now() + timeoutMs;
        const published = await this.sendStop(this.remainingTimeout(deadline));
        const remainingTimeoutMs = this.remainingTimeout(deadline);
        if (published) {
            return await this.waitForCommandAndIdle(published.command.commandId, remainingTimeoutMs);
        }
        return await this.waitForIdle(remainingTimeoutMs);
    }

    async waitForIdle(timeoutMs = 300_000): Promise<CodexV4Snapshot> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const snapshot = await this.readSnapshot(this.remainingTimeout(deadline));
            if (isCodexSnapshotIdle(snapshot)) return snapshot;
            if (!await this.delayUntil(deadline)) break;
        }
        throw new Error('Timeout waiting for Codex to become idle');
    }

    private async publishCommand(
        draft: CommandDraft,
        timeoutMs?: number,
    ): Promise<PublishedCodexCommand> {
        const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
        const commandId = randomUUID();
        const now = Date.now();
        const queueEntryId = draft.command === 'turn.queue'
            ? draft.queueEntryId ?? commandId
            : null;
        const command = {
            schemaVersion: CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION,
            entityType: 'codex.command',
            providerId: commandId,
            createdAt: now,
            updatedAt: now,
            commandId,
            threadId: draft.threadId,
            expectedTurnId: draft.expectedTurnId,
            command: draft.command,
            payload: draft.payload,
            clientUserMessageId: commandId,
            replacesCommandId: null,
            queueEntryId,
            ...(queueEntryId ? { queuedAt: now } : {}),
            ...(draft.bindingGeneration !== undefined
                ? { bindingGeneration: draft.bindingGeneration }
                : {}),
        } as unknown as CodexCommandEntityV4;
        const mutation = this.createMutation(command);
        const body = SyncMutationBatchV4Schema.parse({ mutations: [mutation] });
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                const response = await axios.post(
                    `${this.serverUrl}/v4/sessions/${encodeURIComponent(this.sessionId)}/mutations`,
                    body,
                    {
                        headers: this.headers(),
                        timeout: deadline === null
                            ? 60_000
                            : Math.min(60_000, this.remainingTimeout(deadline)),
                    },
                );
                let parsed: ReturnType<typeof SyncMutationBatchResponseV4Schema.parse>;
                try {
                    parsed = SyncMutationBatchResponseV4Schema.parse(response.data);
                } catch (error) {
                    throw new SyncV4ProtocolError('Codex Sync v4 returned an invalid mutation response', {
                        cause: error,
                    });
                }
                const acknowledgement = parsed.acknowledgements[0];
                if (
                    parsed.acknowledgements.length !== 1
                    || acknowledgement.mutationId !== mutation.mutationId
                    || acknowledgement.revision !== mutation.revision
                ) {
                    throw new SyncV4ProtocolError('Codex Sync v4 response returned a mismatched mutation acknowledgement');
                }
                if (acknowledgement.status === 'superseded') {
                    throw new SyncV4ProtocolError('Codex Sync v4 command mutation was superseded');
                }
                return { command, acknowledgement };
            } catch (error) {
                lastError = error;
                if (error instanceof SyncV4ProtocolError || (axios.isAxiosError(error) && error.response)) break;
                if (attempt < 4) {
                    const retryDelayMs = 250 * 2 ** attempt;
                    if (deadline === null) {
                        await delay(retryDelayMs);
                    } else {
                        const remaining = deadline - Date.now();
                        if (remaining <= 0) break;
                        await delay(Math.min(retryDelayMs, remaining));
                    }
                }
            }
        }
        if (deadline !== null && Date.now() >= deadline) {
            throw new Error('Timeout publishing Codex command');
        }
        throw normalizeTransportError(lastError, 'publishing Codex command');
    }

    private createMutation(entity: CodexEntityV4): SyncMutationV4 {
        const entityId = this.crypto.opaqueEntityId(entity.entityType, entity.providerId);
        const revision = 1;
        const op: SyncMutationOperationV4 = 'upsert';
        return {
            mutationId: randomUUID(),
            producerId: `happy-agent-${randomUUID()}`,
            entityId,
            entityType: entity.entityType,
            revision,
            op,
            ciphertext: this.crypto.encryptEntity({
                sessionId: this.sessionId,
                entityId,
                entityType: entity.entityType,
                revision,
                op,
            }, entity),
        };
    }

    private async assertCompatible(timeoutMs = 30_000): Promise<void> {
        if (this.capabilitiesChecked) return;
        const response = await axios.get(`${this.serverUrl}/v4/capabilities`, {
            headers: this.headers(),
            timeout: timeoutMs,
        });
        const codex = asRecord(asRecord(response.data).codex);
        if (codex.enabled !== true || codex.protocolVersion !== 4) {
            throw new Error('Happy Server does not expose Codex Sync v4');
        }
        const minimumVersion = nonEmptyString(codex.minimumHappyAgentVersion);
        if (!minimumVersion) {
            throw new Error('Happy Server did not advertise a happy-agent Sync v4 version');
        }
        if (!isSyncV4VersionAtLeast(HAPPY_AGENT_VERSION, minimumVersion)) {
            throw new Error(
                `happy-agent ${minimumVersion} or newer is required for Codex Sync v4; found ${HAPPY_AGENT_VERSION}.`,
            );
        }
        this.capabilitiesChecked = true;
    }

    private snapshotRequestTimeout(deadline: number | null): number {
        return deadline === null
            ? 60_000
            : Math.min(60_000, this.remainingTimeout(deadline));
    }

    private remainingTimeout(deadline: number): number {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Timeout waiting for Codex state');
        return remaining;
    }

    private async delayUntil(deadline: number): Promise<boolean> {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        await delay(Math.min(this.pollIntervalMs, remaining));
        return true;
    }

    private headers(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': HAPPY_AGENT_CLIENT_HEADER,
            ...(this.machineId ? { 'X-Happy-Machine-Id': this.machineId } : {}),
        };
    }
}

export function isCodexSnapshotIdle(snapshot: CodexV4Snapshot): boolean {
    if (!snapshot.runtime || snapshot.runtime.statusUnknown) return false;
    if (snapshot.runtime.execution.type !== 'idle') return false;
    return !snapshot.turns.some((turn) => (
        turn.threadId === snapshot.thread?.threadId && turn.status === 'inProgress'
    ));
}

function isCodexTurnTerminal(turn: CodexTurnEntityV4): boolean {
    return ['completed', 'interrupted', 'failed'].includes(turn.status);
}

export function codexHistoryFromSnapshot(snapshot: CodexV4Snapshot): CodexV4HistoryEntry[] {
    const threadId = snapshot.thread?.threadId;
    if (!threadId) return [];
    const items = new Map(snapshot.items.map((item) => [item.itemId, item]));
    const grouped = new Map<string, CodexPartEntityV4[]>();
    for (const part of snapshot.parts) {
        if (part.threadId !== threadId) continue;
        const bucket = grouped.get(part.itemId) ?? [];
        bucket.push(part);
        grouped.set(part.itemId, bucket);
    }
    const entries: CodexV4HistoryEntry[] = [];
    for (const [itemId, parts] of grouped) {
        parts.sort((a, b) => a.index - b.index || a.chunkIndex - b.chunkIndex);
        const first = parts[0];
        const item = items.get(itemId);
        entries.push({
            id: itemId,
            createdAt: item?.createdAt ?? first.createdAt,
            role: historyRole(first.kind),
            text: parts.map((part) => part.content).join(''),
            turnId: first.turnId,
            itemId,
            kind: first.kind,
        });
    }
    return entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function projectSnapshot(
    highWatermark: number,
    entities: CodexEntityV4[],
    preferredThreadId: string | null,
): CodexV4Snapshot {
    const threads = entities.filter(isEntityType('codex.thread'));
    const thread = latestEntity(
        preferredThreadId
            ? threads.filter((candidate) => candidate.threadId === preferredThreadId)
            : threads,
    ) ?? latestEntity(threads);
    const threadId = thread?.threadId ?? preferredThreadId;
    const runtimes = entities
        .filter(isEntityType('codex.runtime'))
        .filter((candidate) => !threadId || candidate.threadId === threadId);
    return {
        highWatermark,
        entities,
        thread,
        runtime: latestEntity(runtimes),
        turns: entities
            .filter(isEntityType('codex.turn'))
            .filter((candidate) => !threadId || candidate.threadId === threadId),
        items: entities
            .filter(isEntityType('codex.item'))
            .filter((candidate) => !threadId || candidate.threadId === threadId),
        parts: entities
            .filter(isEntityType('codex.part'))
            .filter((candidate) => !threadId || candidate.threadId === threadId),
        commandResults: entities
            .filter(isEntityType('codex.commandResult'))
            .filter((candidate) => !threadId || candidate.threadId === null || candidate.threadId === threadId),
    };
}

function isEntityType<T extends CodexEntityV4['entityType']>(entityType: T) {
    return (entity: CodexEntityV4): entity is Extract<CodexEntityV4, { entityType: T }> => (
        entity.entityType === entityType
    );
}

function latestEntity<T extends { updatedAt: number }>(entities: T[]): T | null {
    return entities.reduce<T | null>((latest, candidate) => (
        !latest || candidate.updatedAt > latest.updatedAt ? candidate : latest
    ), null);
}

function bindingGeneration(runtime: CodexRuntimeEntityV4 | null): { bindingGeneration?: number } {
    const gateway = asRecord((runtime as unknown as Record<string, unknown> | null)?.gateway);
    return Number.isSafeInteger(gateway.generation) && (gateway.generation as number) >= 0
        ? { bindingGeneration: gateway.generation as number }
        : {};
}

function historyRole(kind: CodexPartEntityV4['kind']): CodexV4HistoryEntry['role'] {
    if (kind === 'userInput') return 'user';
    if (['commandOutput', 'patch', 'mcpProgress'].includes(kind)) return 'tool';
    return 'assistant';
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTransportError(error: unknown, operation: string): Error {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401) return new Error('Authentication expired. Run `happy-agent auth login` again.');
        if (status === 403) return new Error(`Forbidden while ${operation}`);
        if (status === 404) return new Error('Codex session was not found');
        if (status === 409) return new Error('Codex session is archived or read-only');
        if (status === 426) return new Error('happy-agent must be upgraded for this Codex Sync v4 server');
        return new Error(`Failed while ${operation}${status ? ` (HTTP ${status})` : ''}`);
    }
    return error instanceof Error ? error : new Error(`Failed while ${operation}`);
}
