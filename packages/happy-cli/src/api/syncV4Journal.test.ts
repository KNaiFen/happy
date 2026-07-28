import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    SyncV4Journal,
    SyncV4JournalCorruptionError,
    SyncV4JournalDurabilityError,
    SyncV4JournalLeaseError,
} from "./syncV4Journal";

const temporaryDirectories: string[] = [];
const openJournals = new Set<SyncV4Journal>();

async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-sync-v4-journal-"));
    temporaryDirectories.push(root);
    return root;
}

async function openJournal(
    options: Parameters<typeof SyncV4Journal.open>[0],
): Promise<SyncV4Journal> {
    const journal = await SyncV4Journal.open(options);
    openJournals.add(journal);
    return journal;
}

const mutation = {
    mutationId: "mutation-1",
    producerId: "producer-1",
    entityId: "entity-1",
    entityType: "codex.item" as const,
    revision: 1,
    op: "upsert" as const,
    ciphertext: "ciphertext-1",
};

const command = {
    schemaVersion: 1 as const,
    entityType: "codex.command" as const,
    providerId: "command-1",
    createdAt: 100,
    updatedAt: 100,
    commandId: "command-1",
    threadId: "thread-1",
    expectedTurnId: null,
    command: "turn.start",
    payload: { text: "hello" },
    clientUserMessageId: "command-1",
    replacesCommandId: null,
};

const providerRequest = {
    schemaVersion: 1 as const,
    entityType: "codex.request" as const,
    providerId: "thread-1\0request\0request-1",
    createdAt: 100,
    updatedAt: 100,
    requestId: "request-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestType: "commandApproval" as const,
    status: "pending" as const,
    title: null,
    prompt: "approve command",
    options: {},
    response: null,
    resolvedAt: null,
};

afterEach(async () => {
    await Promise.all([...openJournals].map((journal) => journal.close()));
    openJournals.clear();
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SyncV4Journal", () => {
    it("preserves outbound FIFO until acknowledgements are durable", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1", now: () => 1_000 });
        await journal.appendOutbound([
            mutation,
            { ...mutation, mutationId: "mutation-2", entityId: "entity-2" },
            { ...mutation, mutationId: "mutation-3", entityId: "entity-3" },
        ]);
        await journal.appendAcknowledgements([{
            mutationId: "mutation-1",
            seq: 1,
            revision: 1,
            status: "accepted",
        }]);

        await journal.close();
        const reopened = await openJournal({ rootDir, sessionId: "session-1", now: () => 1_600 });
        expect(reopened.snapshot().pendingOutbound.map((entry) => entry.mutationId)).toEqual([
            "mutation-2",
            "mutation-3",
        ]);
        expect(reopened.nextRevision("entity-1")).toBe(2);
        expect(reopened.diagnostics()).toEqual({
            pendingOutboundDepth: 2,
            pendingOutboundOldestAgeMs: 600,
            pendingInboundDepth: 0,
            pendingInboundOldestAgeMs: null,
        });
    });

    it("replays inbound changes until the independent receive cursor advances", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1" });
        const changes = [1, 2].map((seq) => ({
            ...mutation,
            mutationId: `inbound-${seq}`,
            seq,
            createdAt: 100 + seq,
        }));
        await journal.appendInbound(changes);
        expect(journal.snapshot().pendingInbound.map((entry) => entry.seq)).toEqual([1, 2]);
        expect(journal.diagnostics(500)).toMatchObject({
            pendingInboundDepth: 2,
            pendingInboundOldestAgeMs: 399,
        });
        await journal.advanceReceiveCursor(1);

        await journal.close();
        const reopened = await openJournal({ rootDir, sessionId: "session-1" });
        expect(reopened.snapshot().receiveCursor).toBe(1);
        expect(reopened.snapshot().pendingInbound.map((entry) => entry.seq)).toEqual([2]);
    });

    it("repairs a truncated tail without skipping interior corruption", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1" });
        await journal.appendOutbound([mutation]);
        const journalFile = (await readdir(rootDir)).find((entry) => entry.endsWith(".jsonl"))!;
        const journalPath = join(rootDir, journalFile);
        await journal.close();
        await appendFile(journalPath, '{"version":1,"kind":"outbound"', "utf8");

        const repaired = await openJournal({ rootDir, sessionId: "session-1" });
        expect(repaired.snapshot().pendingOutbound).toHaveLength(1);
        await repaired.appendAcknowledgements([{
            mutationId: "mutation-1",
            seq: 1,
            revision: 1,
            status: "accepted",
        }]);
        expect((await readFile(journalPath, "utf8")).endsWith("\n")).toBe(true);

        await repaired.close();
        await writeFile(journalPath, '{"version":1,"kind":"broken"}\n{}\n', "utf8");
        await expect(SyncV4Journal.open({ rootDir, sessionId: "session-1" }))
            .rejects.toBeInstanceOf(SyncV4JournalCorruptionError);
    });

    it("atomically compacts revisions, pending work, cursor, and command state", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1", compactionBytes: 1 });
        await journal.appendOutbound([mutation]);
        await journal.appendInbound([{
            ...mutation,
            mutationId: "inbound-2",
            seq: 2,
            createdAt: 102,
        }]);
        await journal.advanceReceiveCursor(1);
        await journal.setCommandStatus("command-1", "resultUnknown", command);
        await journal.setMigrationState("thread-1", "ready");
        await journal.compactIfNeeded();

        await journal.close();
        const reopened = await openJournal({ rootDir, sessionId: "session-1" });
        const snapshot = reopened.snapshot();
        expect(snapshot.pendingOutbound).toEqual([mutation]);
        expect(snapshot.pendingInbound.map((entry) => entry.seq)).toEqual([2]);
        expect(snapshot.receiveCursor).toBe(1);
        expect(snapshot.entityRevisions.get("entity-1")).toBe(1);
        expect(snapshot.commandStatuses.get("command-1")).toBe("resultUnknown");
        expect(snapshot.commands.get("command-1")).toEqual(command);
        expect(snapshot.migrationStates.get("thread-1")).toBe("ready");
    });

    it("persists a command transition and its result mutation in one journal append", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1" });
        const resultMutation = {
            ...mutation,
            entityType: "codex.commandResult" as const,
            entityId: "command-result-1",
        };
        await journal.appendCommandTransition("command-1", "executing", resultMutation, command);

        await journal.close();
        const reopened = await openJournal({ rootDir, sessionId: "session-1" });
        const snapshot = reopened.snapshot();
        expect(snapshot.commandStatuses.get("command-1")).toBe("executing");
        expect(snapshot.commands.get("command-1")).toEqual(command);
        expect(snapshot.pendingOutbound).toEqual([resultMutation]);
        expect(snapshot.entityRevisions.get("command-result-1")).toBe(1);
    });

    it("atomically tracks provider requests until a terminal entity is durable", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1", now: () => 200 });
        const pendingMutation = {
            ...mutation,
            entityType: "codex.request" as const,
            entityId: "provider-request-1",
        };
        await journal.appendProviderRequestTransition(providerRequest, "pending", pendingMutation);
        await journal.appendAcknowledgements([{
            mutationId: pendingMutation.mutationId,
            seq: 1,
            revision: 1,
            status: "accepted",
        }]);

        await journal.close();
        const reopened = await openJournal({ rootDir, sessionId: "session-1", now: () => 300 });
        expect(reopened.snapshot().pendingProviderRequests.get(providerRequest.providerId)).toEqual({
            request: providerRequest,
            state: "pending",
            response: null,
        });
        await reopened.appendProviderRequestTransition(
            providerRequest,
            "responseReady",
            undefined,
            { decision: "accept" },
        );
        await reopened.appendProviderRequestTransition(
            providerRequest,
            "responseSupplied",
            undefined,
            { decision: "accept" },
        );
        await reopened.compact();
        await reopened.close();
        const compacted = await openJournal({ rootDir, sessionId: "session-1", now: () => 300 });
        expect(compacted.snapshot().pendingProviderRequests.get(providerRequest.providerId)).toEqual({
            request: providerRequest,
            state: "responseSupplied",
            response: { decision: "accept" },
        });

        const completedRequest = {
            ...providerRequest,
            status: "accepted" as const,
            response: { decision: "accept" },
            resolvedAt: 300,
            updatedAt: 300,
        };
        const completedMutation = {
            ...pendingMutation,
            mutationId: "mutation-2",
            revision: 2,
        };
        await compacted.appendProviderRequestTransition(completedRequest, "resolved", completedMutation);

        await compacted.close();
        const completed = await openJournal({ rootDir, sessionId: "session-1" });
        expect(completed.snapshot().pendingProviderRequests.size).toBe(0);
        expect(completed.snapshot().pendingOutbound).toEqual([completedMutation]);
        expect(completed.snapshot().entityRevisions.get("provider-request-1")).toBe(2);
    });

    it("reads the legacy completed provider-request state as terminal", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1", now: () => 200 });
        await journal.appendProviderRequestTransition(
            providerRequest,
            "pending",
            { ...mutation, entityType: "codex.request", entityId: "provider-request-legacy" },
        );
        await journal.close();

        const journalFile = (await readdir(rootDir)).find((entry) => entry.endsWith(".jsonl"))!;
        await appendFile(join(rootDir, journalFile), `${JSON.stringify({
            version: 1,
            kind: "providerRequest",
            request: {
                ...providerRequest,
                status: "accepted",
                response: { decision: "accept" },
                resolvedAt: 250,
                updatedAt: 250,
            },
            state: "completed",
            updatedAt: 250,
        })}\n`);

        const reopened = await openJournal({ rootDir, sessionId: "session-1" });
        expect(reopened.snapshot().pendingProviderRequests.size).toBe(0);
    });

    it("drops an interrupted command transition as one logical record", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1" });
        await journal.setCommandStatus("command-1", "received", command);
        const resultMutation = {
            ...mutation,
            mutationId: "executing-result",
            entityType: "codex.commandResult" as const,
            entityId: "command-result-1",
        };
        const journalFile = (await readdir(rootDir)).find((entry) => entry.endsWith(".jsonl"))!;
        const journalPath = join(rootDir, journalFile);
        const incomplete = JSON.stringify({
            version: 1,
            kind: "commandTransition",
            commandId: "command-1",
            status: "executing",
            updatedAt: 200,
            mutation: resultMutation,
            command,
        }).slice(0, -12);
        await journal.close();
        await appendFile(journalPath, incomplete, "utf8");

        const reopened = await openJournal({ rootDir, sessionId: "session-1" });
        expect(reopened.snapshot().commandStatuses.get("command-1")).toBe("received");
        expect(reopened.snapshot().pendingOutbound).toEqual([]);
        expect(reopened.nextRevision("command-result-1")).toBe(1);
    });

    it("commits inbound revision with its cursor and snapshot revisions with their watermark", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1" });
        await journal.appendInbound([{ ...mutation, mutationId: "remote-1", seq: 1, createdAt: 100 }]);
        const journalFile = (await readdir(rootDir)).find((entry) => entry.endsWith(".jsonl"))!;
        const journalPath = join(rootDir, journalFile);
        await journal.close();
        await appendFile(
            journalPath,
            '{"version":1,"kind":"inboundComplete","entityId":"entity-1","revision":1',
            "utf8",
        );

        const interrupted = await openJournal({ rootDir, sessionId: "session-1" });
        expect(interrupted.snapshot().receiveCursor).toBe(0);
        expect(interrupted.snapshot().entityRevisions.get("entity-1")).toBeUndefined();
        expect(interrupted.snapshot().pendingInbound).toHaveLength(1);
        await interrupted.completeInbound("entity-1", 1, 1);
        await interrupted.completeSnapshot([{ entityId: "snapshot-entity", revision: 4 }], 7);

        await interrupted.close();
        const completed = await openJournal({ rootDir, sessionId: "session-1" });
        expect(completed.snapshot().receiveCursor).toBe(7);
        expect(completed.snapshot().pendingInbound).toEqual([]);
        expect(completed.snapshot().entityRevisions.get("entity-1")).toBe(1);
        expect(completed.snapshot().entityRevisions.get("snapshot-entity")).toBe(4);
    });

    it("uses one stable producer ID across session journals", async () => {
        const rootDir = await createRoot();
        const first = await openJournal({ rootDir, sessionId: "session-1" });
        const second = await openJournal({ rootDir, sessionId: "session-2" });
        expect(second.producerId).toBe(first.producerId);
        expect(first.producerId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("allows only one writer lease for a session and releases it on close", async () => {
        const rootDir = await createRoot();
        const first = await openJournal({ rootDir, sessionId: "session-1" });

        await expect(SyncV4Journal.open({ rootDir, sessionId: "session-1" }))
            .rejects.toBeInstanceOf(SyncV4JournalLeaseError);

        await first.close();
        const replacement = await openJournal({ rootDir, sessionId: "session-1" });
        await replacement.appendOutbound([mutation]);
        expect(replacement.snapshot().pendingOutbound).toEqual([mutation]);
    });

    it("poisons the writer after a journal durability failure", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1" });
        await journal.appendOutbound([mutation]);
        const journalFile = (await readdir(rootDir)).find((entry) => entry.endsWith(".jsonl"))!;
        const journalPath = join(rootDir, journalFile);
        await rm(journalPath);
        await mkdir(journalPath);

        await expect(journal.appendOutbound([{
            ...mutation,
            mutationId: "mutation-2",
            revision: 2,
        }])).rejects.toBeInstanceOf(SyncV4JournalDurabilityError);
        expect(() => journal.nextRevision("entity-1")).toThrow(SyncV4JournalDurabilityError);
    });

    it("compacts only when enough bytes are reclaimable", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1", compactionBytes: 1 });
        await journal.appendOutbound([mutation]);
        const journalFile = (await readdir(rootDir)).find((entry) => entry.endsWith(".jsonl"))!;
        const journalPath = join(rootDir, journalFile);
        const originalInode = (await stat(journalPath)).ino;

        await journal.compactIfNeeded();
        expect((await stat(journalPath)).ino).toBe(originalInode);

        await journal.appendAcknowledgements([{
            mutationId: mutation.mutationId,
            seq: 1,
            revision: mutation.revision,
            status: "accepted",
        }]);
        await journal.compactIfNeeded();
        expect((await stat(journalPath)).ino).not.toBe(originalInode);
    });

    it("retains only a compact receipt for terminal commands", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1" });
        const executingMutation = {
            ...mutation,
            mutationId: "command-executing",
            entityId: "command-result-1",
            entityType: "codex.commandResult" as const,
        };
        const succeededMutation = {
            ...executingMutation,
            mutationId: "command-succeeded",
            revision: 2,
        };
        await journal.appendCommandTransition("command-1", "executing", executingMutation, command);
        await journal.appendCommandTransition("command-1", "succeeded", succeededMutation, command);
        await journal.appendAcknowledgements([
            { mutationId: executingMutation.mutationId, seq: 1, revision: 1, status: "accepted" },
            { mutationId: succeededMutation.mutationId, seq: 2, revision: 2, status: "accepted" },
        ]);
        await journal.compact();
        await journal.close();

        const reopened = await openJournal({ rootDir, sessionId: "session-1" });
        expect(reopened.snapshot().commandStatuses.get("command-1")).toBe("succeeded");
        expect(reopened.snapshot().commands.has("command-1")).toBe(false);
        const journalFile = (await readdir(rootDir)).find((entry) => entry.endsWith(".jsonl"))!;
        expect(await readFile(join(rootDir, journalFile), "utf8")).not.toContain("hello");
    });

    it("recovers the migration activation handoff after a restart", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1" });
        await journal.setMigrationState("thread-1", "activating");
        await journal.close();

        const reopened = await openJournal({ rootDir, sessionId: "session-1" });
        expect(reopened.getMigrationState("thread-1")).toBe("activating");
    });

    it("recovers Codex orphan FIFO and thread classification after compaction", async () => {
        const rootDir = await createRoot();
        const journal = await openJournal({ rootDir, sessionId: "session-1", now: () => 100 });
        const first = await journal.appendCodexOrphan("thread-child", {
            method: "turn/started",
            params: { threadId: "thread-child", turnId: "turn-1" },
        });
        const second = await journal.appendCodexOrphan("thread-child", {
            method: "turn/completed",
            params: { threadId: "thread-child", turnId: "turn-1" },
        });
        await journal.completeCodexOrphan(first.notificationId);
        await journal.setCodexThreadRoute({
            threadId: "thread-child",
            kind: "providerChild",
            parentThreadId: "thread-root",
            parentTurnId: "turn-root",
            delegationItemId: "item-spawn",
            depth: 1,
            status: "active",
            activeTurnId: "turn-child",
            coordinatedCommandId: "command-child",
        });
        await journal.compact();
        await journal.close();

        const reopened = await openJournal({ rootDir, sessionId: "session-1" });
        expect(reopened.snapshot().pendingCodexNotifications).toEqual([second]);
        expect(reopened.snapshot().codexThreadRoutes.get("thread-child")).toEqual({
            threadId: "thread-child",
            kind: "providerChild",
            parentThreadId: "thread-root",
            parentTurnId: "turn-root",
            delegationItemId: "item-spawn",
            depth: 1,
            status: "active",
            activeTurnId: "turn-child",
            coordinatedCommandId: "command-child",
        });
    });
});
