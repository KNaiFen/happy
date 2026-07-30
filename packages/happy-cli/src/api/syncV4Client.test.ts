import {
    MAX_CODEX_SYNC_V4_PART_BYTES,
    MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE,
    SyncChangesResponseV4Schema,
    SyncSnapshotResponseV4Schema,
    type CodexEntityV4,
    type CodexPartEntityV4,
    type SyncChangeV4,
    type SyncMutationBatchResponseV4,
    type SyncMutationV4,
    type SyncSnapshotResponseV4,
    type SyncV4DiagnosticInput,
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
const openClients = new Set<SyncV4Client>();

class Deferred<T> {
    readonly promise: Promise<T>;
    private resolvePromise!: (value: T | PromiseLike<T>) => void;

    constructor() {
        this.promise = new Promise<T>((resolve) => {
            this.resolvePromise = resolve;
        });
    }

    resolve(value: T): void {
        this.resolvePromise(value);
    }
}

class FakeTransport implements SyncV4Transport {
    readonly postedBatches: SyncMutationV4[][] = [];
    readonly committed = new Map<string, { mutation: SyncMutationV4; seq: number }>();
    changes: SyncChangeV4[] = [];
    snapshots: SyncSnapshotResponseV4[] = [];
    requireSnapshot = false;
    failAfterCommit = false;
    snapshotCallCount = 0;
    readonly snapshotLimits: number[] = [];
    failSnapshotCall: number | null = null;

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

    async getSnapshot(
        _sessionId: string,
        _cursor: string | null,
        limit: number,
    ): Promise<SyncSnapshotResponseV4> {
        this.snapshotLimits.push(limit);
        this.snapshotCallCount += 1;
        if (this.snapshotCallCount === this.failSnapshotCall) throw new Error("snapshot transport lost");
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
    const client = await SyncV4Client.create({
        sessionId: "session-1",
        sessionKey,
        journalRoot,
        transport,
        onEntity: async (event) => { applied.push(event); },
    });
    openClients.add(client);
    return client;
}

afterEach(async () => {
    await Promise.all([...openClients].map((client) => client.close()));
    openClients.clear();
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SyncV4Client", () => {
    it("keeps synchronization running when the diagnostic sink fails", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const client = await SyncV4Client.create({
            sessionId: "session-1",
            sessionKey,
            journalRoot: root,
            transport,
            diagnostics: {
                record: () => {
                    throw new Error("diagnostic sink unavailable");
                },
            },
            generateTraceId: () => "00000000000000000000000000000001",
            onEntity: async () => undefined,
        });
        openClients.add(client);

        await expect(client.start()).resolves.toBeUndefined();
        await expect(client.publishEntity(part("sink-failure"))).resolves.toBeDefined();
        await expect(client.flushOutboundOnce()).resolves.toBeUndefined();
    });

    it("rejects malformed generated trace IDs before calling the transport", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const client = await SyncV4Client.create({
            sessionId: "session-1",
            sessionKey,
            journalRoot: root,
            transport,
            generateTraceId: () => "prompt-reasoning-secret",
            onEntity: async () => undefined,
        });
        openClients.add(client);

        await expect(client.start()).rejects.toThrow("128-bit lowercase hex");
        expect(transport.postedBatches).toEqual([]);
    });

    it("rejects invalid provider entities before allocating transport work", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const client = await createClient(root, transport);
        const invalid = {
            ...part("oversized"),
            content: "\u754c".repeat(Math.floor(MAX_CODEX_SYNC_V4_PART_BYTES / 3) + 1),
        } as CodexEntityV4;

        await expect(client.publishEntity(invalid))
            .rejects.toThrow(`part content exceeds ${MAX_CODEX_SYNC_V4_PART_BYTES} UTF-8 bytes`);
        await client.flushOutboundOnce();
        expect(transport.postedBatches).toEqual([]);
    });

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
        await first.close();

        const reopened = await createClient(root, transport);
        await reopened.flushOutboundOnce();
        expect(transport.postedBatches[1][0].mutationId).toBe(mutation.mutationId);
        expect(transport.committed.size).toBe(1);
    });

    it("records a protocol failure when a successful POST returns mismatched acknowledgements", async () => {
        const root = await createRoot();
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const transport = new FakeTransport();
        transport.postMutations = async (_sessionId, mutations) => ({
            acknowledgements: mutations.map((mutation, index) => ({
                mutationId: `wrong-${index}`,
                seq: index + 1,
                revision: mutation.revision,
                status: "accepted" as const,
            })),
        });
        const client = await SyncV4Client.create({
            sessionId: "session-1",
            sessionKey,
            journalRoot: root,
            transport,
            diagnostics: { record: (input) => diagnostics.push(input) },
            generateTraceId: () => "00000000000000000000000000000001",
            onEntity: async () => undefined,
        });
        openClients.add(client);
        await client.publishEntity(part("bad-ack"));

        await expect(client.flushOutboundOnce()).rejects.toThrow("acknowledgement");
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: "ack",
            phase: "failed",
            traceId: "00000000000000000000000000000001",
            errorKind: "protocol",
        }));
        expect(diagnostics).not.toContainEqual(expect.objectContaining({
            event: "transport",
            phase: "completed",
            traceId: "00000000000000000000000000000001",
        }));
    });

    it("records a protocol failure when changes contain a sequence gap", async () => {
        const root = await createRoot();
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const transport = new FakeTransport();
        transport.getChanges = async () => SyncChangesResponseV4Schema.parse({
            changes: [],
            hasMore: true,
            highWatermark: 1,
        });
        const client = await SyncV4Client.create({
            sessionId: "session-1",
            sessionKey,
            journalRoot: root,
            transport,
            diagnostics: { record: (input) => diagnostics.push(input) },
            generateTraceId: () => "00000000000000000000000000000002",
            onEntity: async () => undefined,
        });
        openClients.add(client);

        await expect(client.pullChangesOnce()).rejects.toThrow("sequence gap");
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: "changes",
            phase: "failed",
            traceId: "00000000000000000000000000000002",
            errorKind: "protocol",
        }));
        expect(diagnostics).not.toContainEqual(expect.objectContaining({
            event: "transport",
            phase: "completed",
            traceId: "00000000000000000000000000000002",
        }));
    });

    it("records an inbound decryption failure after a successful changes response", async () => {
        const transport = new FakeTransport();
        const publisher = await createClient(await createRoot(), transport);
        const mutation = await publisher.publishEntity(part("corrupt-change"));
        const secret = "prompt-reasoning-tool-output-secret";
        transport.changes = [{
            ...mutation,
            ciphertext: secret,
            seq: 1,
            createdAt: 100,
        }];
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const client = await SyncV4Client.create({
            sessionId: "session-1",
            sessionKey,
            journalRoot: await createRoot(),
            transport,
            diagnostics: { record: (input) => diagnostics.push(input) },
            generateTraceId: () => "00000000000000000000000000000003",
            onEntity: async () => undefined,
        });
        openClients.add(client);

        await expect(client.pullChangesOnce()).rejects.toThrow("Unable to authenticate");
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: "transport",
            phase: "completed",
            transportOperation: "changes",
            traceId: "00000000000000000000000000000003",
        }));
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: "changes",
            phase: "failed",
            errorKind: "crypto",
            seq: 1,
        }));
        expect(JSON.stringify(diagnostics)).not.toContain(secret);
        expect(client.receiveCursor).toBe(0);
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
    }, 15_000);

    it("replays a handler failure before advancing its cursor", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const publisher = await createClient(await createRoot(), transport);
        const mutation = await publisher.publishEntity(part("remote-1"));
        transport.changes = [{ ...mutation, seq: 1, createdAt: 100 }];
        const appliedBeforeCrash: SyncV4AppliedEntity[] = [];
        const failing = await SyncV4Client.create({
            sessionId: "session-1",
            sessionKey,
            journalRoot: root,
            transport,
            onEntity: async (event) => {
                appliedBeforeCrash.push(event);
                throw new Error("handler stopped");
            },
        });
        openClients.add(failing);
        await expect(failing.pullChangesOnce()).rejects.toThrow("handler stopped");
        expect(failing.receiveCursor).toBe(0);
        expect(appliedBeforeCrash).toHaveLength(1);
        await failing.close();

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
        expect(transport.snapshotLimits).toEqual([
            MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE,
            MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE,
        ]);
    });

    it("restarts a snapshot from page one when the process stops before its watermark commit", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const publisher = await createClient(await createRoot(), transport);
        const first = await publisher.publishEntity(part("snapshot-crash-1"));
        const second = await publisher.publishEntity(part("snapshot-crash-2"));
        const { mutationId: _firstMutationId, ...firstSnapshot } = first;
        const { mutationId: _secondMutationId, ...secondSnapshot } = second;
        const pages: SyncSnapshotResponseV4[] = [
            {
                entities: [{ ...firstSnapshot, updatedSeq: 1, createdAt: 100, updatedAt: 100 }],
                highWatermark: 2,
                nextCursor: "page-2",
            },
            {
                entities: [{ ...secondSnapshot, updatedSeq: 2, createdAt: 101, updatedAt: 101 }],
                highWatermark: 2,
                nextCursor: null,
            },
        ];
        transport.requireSnapshot = true;
        transport.snapshots = structuredClone(pages);
        transport.failSnapshotCall = 2;
        const beforeCrash: SyncV4AppliedEntity[] = [];
        const interrupted = await createClient(root, transport, beforeCrash);
        await expect(interrupted.pullChangesOnce()).rejects.toThrow("snapshot transport lost");
        expect(beforeCrash.map((event) => event.entity.providerId)).toEqual(["snapshot-crash-1"]);
        await interrupted.close();

        transport.requireSnapshot = true;
        transport.snapshots = structuredClone(pages);
        transport.snapshotCallCount = 0;
        transport.failSnapshotCall = null;
        const recovered: SyncV4AppliedEntity[] = [];
        const reopened = await createClient(root, transport, recovered);
        await reopened.pullChangesOnce();
        expect(recovered.map((event) => event.entity.providerId)).toEqual([
            "snapshot-crash-1",
            "snapshot-crash-2",
        ]);
        expect(reopened.receiveCursor).toBe(2);
    });

    it("rejects duplicate entities across snapshot pages without committing the cursor", async () => {
        const transport = new FakeTransport();
        const publisher = await createClient(await createRoot(), transport);
        const mutation = await publisher.publishEntity(part("duplicate-snapshot"));
        const { mutationId: _mutationId, ...snapshot } = mutation;
        transport.requireSnapshot = true;
        transport.snapshots = [
            {
                entities: [{ ...snapshot, updatedSeq: 1, createdAt: 100, updatedAt: 100 }],
                highWatermark: 2,
                nextCursor: "page-2",
            },
            {
                entities: [{ ...snapshot, updatedSeq: 1, createdAt: 100, updatedAt: 100 }],
                highWatermark: 2,
                nextCursor: null,
            },
        ];
        const diagnostics: SyncV4DiagnosticInput[] = [];
        const applied: SyncV4AppliedEntity[] = [];
        const traceIds = [
            "00000000000000000000000000000004",
            "00000000000000000000000000000005",
            "00000000000000000000000000000006",
        ];
        const client = await SyncV4Client.create({
            sessionId: "session-1",
            sessionKey,
            journalRoot: await createRoot(),
            transport,
            diagnostics: { record: (input) => diagnostics.push(input) },
            generateTraceId: () => traceIds.shift()!,
            onEntity: async (event) => { applied.push(event); },
        });
        openClients.add(client);

        await expect(client.pullChangesOnce()).rejects.toThrow("repeated an entity");
        expect(applied).toHaveLength(1);
        expect(client.receiveCursor).toBe(0);
        expect(diagnostics).toContainEqual(expect.objectContaining({
            event: "snapshot",
            phase: "failed",
            traceId: "00000000000000000000000000000006",
            page: 1,
            errorKind: "protocol",
        }));
        expect(diagnostics).not.toContainEqual(expect.objectContaining({
            event: "transport",
            phase: "completed",
            traceId: "00000000000000000000000000000006",
        }));
    });

    it("rejects snapshot entities newer than the page watermark before projection", async () => {
        const transport = new FakeTransport();
        const publisher = await createClient(await createRoot(), transport);
        const mutation = await publisher.publishEntity(part("future-snapshot"));
        const { mutationId: _mutationId, ...snapshot } = mutation;
        transport.requireSnapshot = true;
        transport.snapshots = [{
            entities: [{ ...snapshot, updatedSeq: 2, createdAt: 100, updatedAt: 100 }],
            highWatermark: 1,
            nextCursor: null,
        }];
        transport.getSnapshot = async () => {
            const page = transport.snapshots.shift();
            if (!page) throw new Error("missing fake snapshot page");
            return page;
        };
        const applied: SyncV4AppliedEntity[] = [];
        const client = await createClient(await createRoot(), transport, applied);

        await expect(client.pullChangesOnce()).rejects.toThrow(
            "snapshot entity exceeds its high watermark",
        );
        expect(applied).toEqual([]);
        expect(client.receiveCursor).toBe(0);
    });

    it("does not acknowledge an in-flight POST after stop", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const client = await createClient(root, transport);
        const mutation = await client.publishEntity(part("pending-after-stop"));
        const postStarted = new Deferred<void>();
        const postResponse = new Deferred<SyncMutationBatchResponseV4>();
        transport.postMutations = async () => {
            postStarted.resolve();
            return await postResponse.promise;
        };

        const flush = client.flushOutboundOnce();
        await postStarted.promise;
        client.stop();
        postResponse.resolve({
            acknowledgements: [{
                mutationId: mutation.mutationId,
                seq: 1,
                revision: mutation.revision,
                status: "accepted",
            }],
        });
        await flush;
        await client.close();

        const retryTransport = new FakeTransport();
        await (await createClient(root, retryTransport)).flushOutboundOnce();
        expect(retryTransport.postedBatches).toHaveLength(1);
        expect(retryTransport.postedBatches[0][0].mutationId).toBe(mutation.mutationId);
    });

    it("does not apply changes or advance the cursor after stop", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const publisher = await createClient(await createRoot(), transport);
        const mutation = await publisher.publishEntity(part("late-change"));
        const changeStarted = new Deferred<void>();
        const changeResponse = new Deferred<ReturnType<typeof SyncChangesResponseV4Schema.parse>>();
        transport.getChanges = async () => {
            changeStarted.resolve();
            return await changeResponse.promise;
        };
        const applied: SyncV4AppliedEntity[] = [];
        const client = await createClient(root, transport, applied);

        const pull = client.pullChangesOnce();
        await changeStarted.promise;
        client.stop();
        changeResponse.resolve(SyncChangesResponseV4Schema.parse({
            changes: [{ ...mutation, seq: 1, createdAt: 100 }],
            hasMore: false,
            highWatermark: 1,
        }));
        await pull;

        expect(applied).toEqual([]);
        expect(client.receiveCursor).toBe(0);
    });

    it("does not complete an in-flight snapshot after stop", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const publisher = await createClient(await createRoot(), transport);
        const mutation = await publisher.publishEntity(part("late-snapshot"));
        const { mutationId: _mutationId, ...snapshot } = mutation;
        transport.requireSnapshot = true;
        const snapshotStarted = new Deferred<void>();
        const snapshotResponse = new Deferred<SyncSnapshotResponseV4>();
        transport.getSnapshot = async () => {
            snapshotStarted.resolve();
            return await snapshotResponse.promise;
        };
        const applied: SyncV4AppliedEntity[] = [];
        const client = await createClient(root, transport, applied);

        const pull = client.pullChangesOnce();
        await snapshotStarted.promise;
        client.stop();
        snapshotResponse.resolve(SyncSnapshotResponseV4Schema.parse({
            entities: [{ ...snapshot, updatedSeq: 1, createdAt: 100, updatedAt: 100 }],
            highWatermark: 1,
            nextCursor: null,
        }));
        await pull;

        expect(applied).toEqual([]);
        expect(client.receiveCursor).toBe(0);
    });

    it("flushes only mutations that existed when an explicit flush began", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const client = await createClient(root, transport);
        const first = await client.publishEntity(part("initial"));
        const post = transport.postMutations.bind(transport);
        let publishedDuringFlush = false;
        transport.postMutations = async (sessionId, mutations) => {
            if (!publishedDuringFlush) {
                publishedDuringFlush = true;
                await client.publishEntity(part("later"));
            }
            return await post(sessionId, mutations);
        };

        await client.flushOutboundOnce();
        expect(transport.postedBatches.flat().map((entry) => entry.mutationId)).toEqual([first.mutationId]);

        await client.flushOutboundOnce();
        expect(transport.postedBatches.flat()).toHaveLength(2);
    });

    it("stops an inbound drain at the first observed high watermark", async () => {
        const root = await createRoot();
        const transport = new FakeTransport();
        const publisher = await createClient(await createRoot(), transport);
        for (let index = 0; index < 200; index += 1) {
            const mutation = await publisher.publishEntity(part(`moving-${index}`));
            transport.changes.push({ ...mutation, seq: index + 1, createdAt: 100 + index });
        }
        const allChanges = [...transport.changes];
        transport.changes = allChanges.slice(0, 100);
        const getChanges = transport.getChanges.bind(transport);
        let calls = 0;
        transport.getChanges = async (...args) => {
            const response = await getChanges(...args);
            calls += 1;
            if (calls === 1) transport.changes = allChanges;
            return response;
        };
        const applied: SyncV4AppliedEntity[] = [];
        const client = await createClient(root, transport, applied);

        await client.pullChangesOnce();
        expect(client.receiveCursor).toBe(100);
        expect(applied).toHaveLength(100);

        await client.pullChangesOnce();
        expect(client.receiveCursor).toBe(200);
        expect(applied).toHaveLength(200);
    }, 15_000);
});
