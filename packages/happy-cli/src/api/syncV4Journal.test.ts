import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncV4Journal, SyncV4JournalCorruptionError } from "./syncV4Journal";

const temporaryDirectories: string[] = [];

async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-sync-v4-journal-"));
    temporaryDirectories.push(root);
    return root;
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

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SyncV4Journal", () => {
    it("preserves outbound FIFO until acknowledgements are durable", async () => {
        const rootDir = await createRoot();
        const journal = await SyncV4Journal.open({ rootDir, sessionId: "session-1" });
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

        const reopened = await SyncV4Journal.open({ rootDir, sessionId: "session-1" });
        expect(reopened.snapshot().pendingOutbound.map((entry) => entry.mutationId)).toEqual([
            "mutation-2",
            "mutation-3",
        ]);
        expect(reopened.nextRevision("entity-1")).toBe(2);
    });

    it("replays inbound changes until the independent receive cursor advances", async () => {
        const rootDir = await createRoot();
        const journal = await SyncV4Journal.open({ rootDir, sessionId: "session-1" });
        const changes = [1, 2].map((seq) => ({
            ...mutation,
            mutationId: `inbound-${seq}`,
            seq,
            createdAt: 100 + seq,
        }));
        await journal.appendInbound(changes);
        expect(journal.snapshot().pendingInbound.map((entry) => entry.seq)).toEqual([1, 2]);
        await journal.advanceReceiveCursor(1);

        const reopened = await SyncV4Journal.open({ rootDir, sessionId: "session-1" });
        expect(reopened.snapshot().receiveCursor).toBe(1);
        expect(reopened.snapshot().pendingInbound.map((entry) => entry.seq)).toEqual([2]);
    });

    it("repairs a truncated tail without skipping interior corruption", async () => {
        const rootDir = await createRoot();
        const journal = await SyncV4Journal.open({ rootDir, sessionId: "session-1" });
        await journal.appendOutbound([mutation]);
        const journalFile = (await readdir(rootDir)).find((entry) => entry.endsWith(".jsonl"))!;
        const journalPath = join(rootDir, journalFile);
        await appendFile(journalPath, '{"version":1,"kind":"outbound"', "utf8");

        const repaired = await SyncV4Journal.open({ rootDir, sessionId: "session-1" });
        expect(repaired.snapshot().pendingOutbound).toHaveLength(1);
        await repaired.appendAcknowledgements([{
            mutationId: "mutation-1",
            seq: 1,
            revision: 1,
            status: "accepted",
        }]);
        expect((await readFile(journalPath, "utf8")).endsWith("\n")).toBe(true);

        await writeFile(journalPath, '{"version":1,"kind":"broken"}\n{}\n', "utf8");
        await expect(SyncV4Journal.open({ rootDir, sessionId: "session-1" }))
            .rejects.toBeInstanceOf(SyncV4JournalCorruptionError);
    });

    it("atomically compacts revisions, pending work, cursor, and command state", async () => {
        const rootDir = await createRoot();
        const journal = await SyncV4Journal.open({ rootDir, sessionId: "session-1", compactionBytes: 1 });
        await journal.appendOutbound([mutation]);
        await journal.appendInbound([{
            ...mutation,
            mutationId: "inbound-2",
            seq: 2,
            createdAt: 102,
        }]);
        await journal.advanceReceiveCursor(1);
        await journal.setCommandStatus("command-1", "resultUnknown");
        await journal.compactIfNeeded();

        const reopened = await SyncV4Journal.open({ rootDir, sessionId: "session-1" });
        const snapshot = reopened.snapshot();
        expect(snapshot.pendingOutbound).toEqual([mutation]);
        expect(snapshot.pendingInbound.map((entry) => entry.seq)).toEqual([2]);
        expect(snapshot.receiveCursor).toBe(1);
        expect(snapshot.entityRevisions.get("entity-1")).toBe(1);
        expect(snapshot.commandStatuses.get("command-1")).toBe("resultUnknown");
    });

    it("uses one stable producer ID across session journals", async () => {
        const rootDir = await createRoot();
        const first = await SyncV4Journal.open({ rootDir, sessionId: "session-1" });
        const second = await SyncV4Journal.open({ rootDir, sessionId: "session-2" });
        expect(second.producerId).toBe(first.producerId);
        expect(first.producerId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
