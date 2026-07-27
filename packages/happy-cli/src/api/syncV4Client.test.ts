import {
    SyncChangesResponseV4Schema,
    SyncSnapshotResponseV4Schema,
    type CodexPartEntityV4,
    type SyncChangeV4,
    type SyncMutationBatchResponseV4,
    type SyncMutationV4,
    type SyncSnapshotResponseV4,
} from "@slopus/happy-wire";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    SyncV4Client,
    SyncV4SnapshotRequiredError,
    type SyncV4AppliedEntity,
    type SyncV4Transport,
} from "./syncV4Client";

const sessionKey = Uint8Array.from({ length: 32 }, (_, index) => index);
const temporaryDirectories: string[] = [];

class FakeTransport implements SyncV4Transport {
    readonly postedBatches: SyncMutationV4[][] = [];
    readonly committed = new Map<string, { mutation: SyncMutationV4; seq: number }>();
    changes: SyncChangeV4[] = [];
    snapshots: SyncSnapshotResponseV4[] = [];
    requireSnapshot = false;
    failAfterCommit = false;

    async postMutations(_sessionId: string, mutations: SyncMutationV4[]): Promise<SyncMutationBatchResponseV4> {
        this.postedBatches.push(mutations);
        const acknowledgements = mutations.map((mutation) => {
            const existing = this.committed.get(mutation.mutationId);
            if (existing) {
                return { mutationId: mutation.mutationId, seq: existing.seq, revision: mutation.revision, status: "duplicate" as const };
            }
            const seq = this.committed.size + 1;
            this.committed.set(mutation.mutationId, { mutation, seq });
            return { mutationId: mutation.mutationId, seq, revision: mutation.revision, status: "accepted" as const };
        });
        if (this.failAfterCommit) {
            this.failAfterCommit = false;
            throw new Error("connection lost after commit");
        }
        return { acknowledgements };
    }

    async getChanges(_sessionId: string, afterSeq: number, limit: number) {
        if (this.requireSnapshot) {
            this.requireSnapshot = false;
            throw new SyncV4SnapshotRequiredError(1, this.changes.at(-1)?.seq ?? 0);
        }
        const remaining = this.changes.filter((change) => change.seq > afterSeq);
        const page = remaining.slice(0, limit);
        return SyncChangesResponseV4Schema.parse({
            changes: page,
            hasMore: remaining.length > page.length,
            highWatermark: this.changes.at(-1)?.seq ?? afterSeq,
        });
    }

    async getSnapshot(): Promise<SyncSnapshotResponseV4> {
        const page = this.snapshots.shift();
        if (!page) throw new Error("missing fake snapshot page");
        return SyncSnapshotResponseV4Schema.parse(page);
    }
}

async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-sync-v4-client-"));
    temporaryDirectories.push(root);
    return root;
}

function part(providerId: string, content: string = providerId): CodexPartEntityV4 {
    return {
        schemaVersion: 1,
        entityType: "codex.part",
        providerId,
        createdAt: 10,
        updatedAt: 11,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: `item-${providerId}`,
        partId: providerId,
        kind: "text",
        index: 0,
        chunkIndex: 0,
        content,
        contentType: "text",
        final: true,
    };
}

async function createClient(
    journalRoot: string,
    transport: SyncV4Transport,
    applied: SyncV4AppliedEntity[] = [],
): Promise<SyncV4Client> {
    return SyncV4Client.create({
        sessionId: "session-1",
        sessionKey,
        journalRoot,
        transport,
        onEntity: async (event) => { applied.push(event); },
    });
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SyncV4Client", () => {
    it("assigns consecutive revisions to one entity within a durable batch", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const client = await createClient(root, transport);
        const mutations = await client.publishEntities([
            { entity: part("same-part", "first") },
            { entity: part("same-part", "second") },
        ]);

        expect(mutations.map((mutation) => mutation.revision)).toEqual([1, 2]);
        await client.flushOutboundOnce();
        expect((await client.publishEntity(part("same-part", "third"))).revision).toBe(3);
    });

    it("sends 120 durable mutations FIFO without moving the receive cursor", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const client = await createClient(root, transport);
        for (let index = 0; index < 120; index += 1) {
            await client.publishEntity(part(`part-${index}`));
        }
        await client.flushOutboundOnce();

        expect(transport.postedBatches.map((batch) => batch.length)).toEqual([100, 20]);
        expect(transport.postedBatches.flat().map((mutation) => mutation.entityId))
            .toEqual([...transport.committed.values()].map(({ mutation }) => mutation.entityId));
        expect(client.receiveCursor).toBe(0);
    });

    it("retries an uncertain POST with the same mutation ID", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const first = await createClient(root, transport);
        const mutation = await first.publishEntity(part("part-1"));
        transport.failAfterCommit = true;
        await expect(first.flushOutboundOnce()).rejects.toThrow("connection lost");

        const reopened = await createClient(root, transport);
        await reopened.flushOutboundOnce();
        expect(transport.postedBatches[1][0].mutationId).toBe(mutation.mutationId);
        expect(transport.committed.size).toBe(1);
    });

    it("pulls and applies 225 contiguous changes without relying on invalidations", async () => {
        const root = await createRoot();
        const source = new FakeTransport();
        const publisher = await createClient(await createRoot(), source);
        for (let index = 0; index < 225; index += 1) {
            const mutation = await publisher.publishEntity(part(`remote-${index}`));
            source.changes.push({ ...mutation, seq: index + 1, createdAt: 100 + index });
        }
        const applied: SyncV4AppliedEntity[] = [];
        const client = await createClient(root, source, applied);
        await client.pullChangesOnce();

        expect(applied).toHaveLength(225);
        expect(applied[0].entity.providerId).toBe("remote-0");
        expect(applied.at(-1)?.entity.providerId).toBe("remote-224");
        expect(client.receiveCursor).toBe(225);
    });

    it("replays a handler failure before advancing its cursor", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const publisher = await createClient(await createRoot(), transport);
        const mutation = await publisher.publishEntity(part("remote-1"));
        transport.changes = [{ ...mutation, seq: 1, createdAt: 100 }];
        const failing = await SyncV4Client.create({
            sessionId: "session-1",
            sessionKey,
            journalRoot: root,
            transport,
            onEntity: async () => { throw new Error("handler stopped"); },
        });
        await expect(failing.pullChangesOnce()).rejects.toThrow("handler stopped");
        expect(failing.receiveCursor).toBe(0);

        const applied: SyncV4AppliedEntity[] = [];
        const reopened = await createClient(root, transport, applied);
        await reopened.pullChangesOnce();
        expect(applied).toHaveLength(1);
        expect(reopened.receiveCursor).toBe(1);
    });

    it("recovers an expired cursor from a paginated snapshot", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const publisher = await createClient(await createRoot(), transport);
        const first = await publisher.publishEntity(part("snapshot-1"));
        const second = await publisher.publishEntity(part("snapshot-2"));
        const { mutationId: _firstMutationId, ...firstSnapshot } = first;
        const { mutationId: _secondMutationId, ...secondSnapshot } = second;
        transport.requireSnapshot = true;
        transport.snapshots = [
            {
                entities: [{
                    ...firstSnapshot,
                    updatedSeq: 1,
                    createdAt: 100,
                    updatedAt: 100,
                }],
                highWatermark: 2,
                nextCursor: "page-2",
            },
            {
                entities: [{
                    ...secondSnapshot,
                    updatedSeq: 2,
                    createdAt: 101,
                    updatedAt: 101,
                }],
                highWatermark: 2,
                nextCursor: null,
            },
        ];
        const applied: SyncV4AppliedEntity[] = [];
        const client = await createClient(root, transport, applied);
        await client.pullChangesOnce();

        expect(applied.map((event) => event.source)).toEqual(["snapshot", "snapshot"]);
        expect(client.receiveCursor).toBe(2);
    });
});
