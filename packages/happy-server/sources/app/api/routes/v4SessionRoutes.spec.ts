import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

type SessionRecord = {
    id: string;
    accountId: string;
    syncV4Seq: number;
};

type MutationRecord = {
    id: string;
    sessionId: string;
    mutationId: string;
    producerId: string;
    entityId: string;
    entityType: string;
    revision: number;
    op: string;
    ciphertext: string;
    status: string;
    seq: number;
    createdAt: Date;
};

type EntityRecord = {
    id: string;
    sessionId: string;
    producerId: string;
    entityId: string;
    entityType: string;
    revision: number;
    op: string;
    ciphertext: string;
    updatedSeq: number;
    createdAt: Date;
    updatedAt: Date;
};

const { state, dbMock, emitEphemeralMock, resetState, seedSession } = vi.hoisted(() => {
    const state = {
        sessions: [] as SessionRecord[],
        mutations: [] as MutationRecord[],
        entities: [] as EntityRecord[],
        nextMutationId: 1,
        nextEntityId: 1,
        nowMs: 1700000000000,
    };

    const resetState = () => {
        state.sessions = [];
        state.mutations = [];
        state.entities = [];
        state.nextMutationId = 1;
        state.nextEntityId = 1;
        state.nowMs = 1700000000000;
    };

    const seedSession = (id: string, accountId: string) => {
        state.sessions.push({ id, accountId, syncV4Seq: 0 });
    };

    const selectFields = <T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) => {
        if (!select) return { ...row };
        const result: Record<string, unknown> = {};
        for (const [key, enabled] of Object.entries(select)) {
            if (enabled) result[key] = row[key];
        }
        return result;
    };

    const sessionFindFirst = vi.fn(async (args: any) => {
        const session = state.sessions.find((candidate) => (
            candidate.id === args?.where?.id && candidate.accountId === args?.where?.accountId
        ));
        return session
            ? selectFields(session as unknown as Record<string, unknown>, args?.select)
            : null;
    });

    const sessionUpdate = vi.fn(async (args: any) => {
        const session = state.sessions.find((candidate) => candidate.id === args?.where?.id);
        if (!session) throw new Error("Session not found");
        session.syncV4Seq += args?.data?.syncV4Seq?.increment ?? 0;
        return selectFields(session as unknown as Record<string, unknown>, args?.select);
    });

    const mutationFindMany = vi.fn(async (args: any) => {
        let rows = state.mutations.filter((mutation) => mutation.sessionId === args?.where?.sessionId);
        if (Array.isArray(args?.where?.mutationId?.in)) {
            const ids = new Set(args.where.mutationId.in);
            rows = rows.filter((mutation) => ids.has(mutation.mutationId));
        }
        if (typeof args?.where?.seq?.gt === "number") {
            rows = rows.filter((mutation) => mutation.seq > args.where.seq.gt);
        }
        if (args?.orderBy?.seq === "asc") rows.sort((left, right) => left.seq - right.seq);
        if (typeof args?.take === "number") rows = rows.slice(0, args.take);
        return rows.map((row) => selectFields(row as unknown as Record<string, unknown>, args?.select));
    });

    const mutationCreate = vi.fn(async (args: any) => {
        const row: MutationRecord = {
            id: `mutation-row-${state.nextMutationId++}`,
            ...args.data,
            createdAt: new Date(state.nowMs++),
        };
        state.mutations.push(row);
        return selectFields(row as unknown as Record<string, unknown>, args?.select);
    });

    const mutationAggregate = vi.fn(async (args: any) => {
        const rows = state.mutations.filter((mutation) => mutation.sessionId === args?.where?.sessionId);
        return { _min: { seq: rows.length > 0 ? Math.min(...rows.map((mutation) => mutation.seq)) : null } };
    });

    const mutationDeleteMany = vi.fn(async () => ({ count: 0 }));

    const entityFindMany = vi.fn(async (args: any) => {
        let rows = state.entities.filter((entity) => entity.sessionId === args?.where?.sessionId);
        if (Array.isArray(args?.where?.entityId?.in)) {
            const ids = new Set(args.where.entityId.in);
            rows = rows.filter((entity) => ids.has(entity.entityId));
        }
        if (typeof args?.where?.entityId?.gt === "string") {
            rows = rows.filter((entity) => entity.entityId > args.where.entityId.gt);
        }
        if (typeof args?.where?.updatedSeq?.lte === "number") {
            rows = rows.filter((entity) => entity.updatedSeq <= args.where.updatedSeq.lte);
        }
        if (args?.orderBy?.entityId === "asc") {
            rows.sort((left, right) => left.entityId.localeCompare(right.entityId));
        }
        if (typeof args?.take === "number") rows = rows.slice(0, args.take);
        return rows.map((row) => selectFields(row as unknown as Record<string, unknown>, args?.select));
    });

    const entityUpsert = vi.fn(async (args: any) => {
        const key = args.where.sessionId_entityId;
        const existing = state.entities.find((entity) => (
            entity.sessionId === key.sessionId && entity.entityId === key.entityId
        ));
        if (existing) {
            Object.assign(existing, args.update, { updatedAt: new Date(state.nowMs++) });
            return existing;
        }
        const now = new Date(state.nowMs++);
        const created: EntityRecord = {
            id: `entity-row-${state.nextEntityId++}`,
            ...args.create,
            createdAt: now,
            updatedAt: now,
        };
        state.entities.push(created);
        return created;
    });

    const txClient = {
        session: { update: sessionUpdate },
        sessionMutationV4: {
            findMany: mutationFindMany,
            create: mutationCreate,
            deleteMany: mutationDeleteMany,
        },
        sessionEntityV4: { findMany: entityFindMany, upsert: entityUpsert },
    };

    const dbMock = {
        session: { findFirst: sessionFindFirst, update: sessionUpdate },
        sessionMutationV4: {
            findMany: mutationFindMany,
            create: mutationCreate,
            aggregate: mutationAggregate,
            deleteMany: mutationDeleteMany,
        },
        sessionEntityV4: { findMany: entityFindMany, upsert: entityUpsert },
        $transaction: vi.fn(async (operation: any) => operation(txClient)),
    };

    return {
        state,
        dbMock,
        emitEphemeralMock: vi.fn(),
        resetState,
        seedSession,
    };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitEphemeral: emitEphemeralMock },
}));

import { v4SessionRoutes } from "./v4SessionRoutes";

const mutation = {
    mutationId: "mutation-1",
    producerId: "producer-1",
    entityId: "opaque-entity-1",
    entityType: "codex.item",
    revision: 1,
    op: "upsert",
    ciphertext: "encrypted-v1",
};

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") return reply.code(401).send({ error: "Unauthorized" });
        request.userId = userId;
    });
    v4SessionRoutes(typed);
    await typed.ready();
    return typed;
}

describe("v4SessionRoutes", () => {
    let app: Fastify;

    beforeEach(() => {
        resetState();
        emitEphemeralMock.mockClear();
    });

    afterEach(async () => {
        if (app) await app.close();
    });

    it("stores encrypted mutations and returns acknowledgements without a receive cursor", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation] },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            acknowledgements: [{ mutationId: "mutation-1", seq: 1, revision: 1, status: "accepted" }],
        });
        expect(state.entities[0]).toMatchObject({ revision: 1, ciphertext: "encrypted-v1", updatedSeq: 1 });
        expect(emitEphemeralMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: { type: "sync-v4-invalidate", sessionId: "session-1", highWatermark: 1 },
        }));
    });

    it("deduplicates mutation ids without allocating another sequence", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        const request = {
            method: "POST" as const,
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation] },
        };
        await app.inject(request);
        const retry = await app.inject(request);

        expect(retry.statusCode).toBe(200);
        expect(retry.json().acknowledgements).toEqual([
            { mutationId: "mutation-1", seq: 1, revision: 1, status: "duplicate" },
        ]);
        expect(state.sessions[0].syncV4Seq).toBe(1);
        expect(state.mutations).toHaveLength(1);
    });

    it("rejects duplicate ids in a batch and conflicting mutation retries", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        const duplicateBatch = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation, mutation] },
        });
        expect(duplicateBatch.statusCode).toBe(400);
        expect(state.mutations).toHaveLength(0);

        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation] },
        });
        const conflictingRetry = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [{ ...mutation, ciphertext: "changed" }] },
        });
        expect(conflictingRetry.statusCode).toBe(409);
        expect(conflictingRetry.json()).toEqual({ error: "mutationConflict", mutationId: "mutation-1" });
        expect(state.mutations).toHaveLength(1);
    });

    it("advances revisions, journals stale revisions, and keeps the latest snapshot", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation] },
        });
        const response = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: {
                mutations: [
                    { ...mutation, mutationId: "mutation-2", revision: 3, ciphertext: "encrypted-v3" },
                    { ...mutation, mutationId: "mutation-3", revision: 2, ciphertext: "encrypted-v2" },
                ],
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().acknowledgements).toEqual([
            { mutationId: "mutation-2", seq: 2, revision: 3, status: "accepted" },
            { mutationId: "mutation-3", seq: 3, revision: 2, status: "superseded" },
        ]);

        const snapshot = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/snapshot",
            headers: { "x-user-id": "user-1" },
        });
        expect(snapshot.statusCode).toBe(200);
        expect(snapshot.json()).toMatchObject({
            highWatermark: 3,
            entities: [{ entityId: "opaque-entity-1", revision: 3, ciphertext: "encrypted-v3" }],
        });
    });

    it("applies multiple revisions for one entity in batch order", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: {
                mutations: [
                    mutation,
                    { ...mutation, mutationId: "mutation-2", revision: 2, ciphertext: "encrypted-v2" },
                    { ...mutation, mutationId: "mutation-3", revision: 3, ciphertext: "encrypted-v3" },
                ],
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().acknowledgements.map((ack: { status: string }) => ack.status)).toEqual([
            "accepted",
            "accepted",
            "accepted",
        ]);
        expect(state.entities).toHaveLength(1);
        expect(state.entities[0]).toMatchObject({ revision: 3, ciphertext: "encrypted-v3", updatedSeq: 3 });
    });

    it("persists delete tombstones in snapshots", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: {
                mutations: [
                    mutation,
                    { ...mutation, mutationId: "mutation-2", revision: 2, op: "delete", ciphertext: "tombstone" },
                ],
            },
        });

        const snapshot = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/snapshot",
            headers: { "x-user-id": "user-1" },
        });
        expect(snapshot.json().entities).toEqual([
            expect.objectContaining({ entityId: "opaque-entity-1", revision: 2, op: "delete" }),
        ]);
    });

    it("rejects a conflicting same revision atomically", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation] },
        });
        const conflict = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: {
                mutations: [{ ...mutation, mutationId: "mutation-2", ciphertext: "different" }],
            },
        });

        expect(conflict.statusCode).toBe(409);
        expect(conflict.json()).toEqual({ error: "revisionConflict", entityId: "opaque-entity-1", revision: 1 });
        expect(state.sessions[0].syncV4Seq).toBe(1);
        expect(state.mutations).toHaveLength(1);
    });

    it("reads changes in order and enforces session ownership", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: {
                mutations: [
                    mutation,
                    { ...mutation, mutationId: "mutation-2", entityId: "opaque-entity-2" },
                ],
            },
        });

        const changes = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0&limit=1",
            headers: { "x-user-id": "user-1" },
        });
        expect(changes.statusCode).toBe(200);
        expect(changes.json()).toMatchObject({
            hasMore: true,
            highWatermark: 2,
            changes: [{ mutationId: "mutation-1", seq: 1 }],
        });

        const wrongOwner = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: { "x-user-id": "user-2" },
        });
        expect(wrongOwner.statusCode).toBe(404);
    });

    it("requires a snapshot when the receive cursor predates retained journal rows", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: {
                mutations: [
                    mutation,
                    { ...mutation, mutationId: "mutation-2", entityId: "opaque-entity-2" },
                ],
            },
        });
        state.mutations.shift();

        const expired = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: { "x-user-id": "user-1" },
        });
        expect(expired.statusCode).toBe(410);
        expect(expired.json()).toEqual({ error: "snapshotRequired", minimumSeq: 2, highWatermark: 2 });

        state.mutations = [];
        const fullyPruned = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: { "x-user-id": "user-1" },
        });
        expect(fullyPruned.statusCode).toBe(410);
        expect(fullyPruned.json()).toEqual({ error: "snapshotRequired", minimumSeq: 3, highWatermark: 2 });
    });

    it("paginates a stable snapshot and rejects future watermarks", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: {
                mutations: [
                    mutation,
                    { ...mutation, mutationId: "mutation-2", entityId: "opaque-entity-2" },
                    { ...mutation, mutationId: "mutation-3", entityId: "opaque-entity-3" },
                ],
            },
        });

        const first = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/snapshot?limit=2",
            headers: { "x-user-id": "user-1" },
        });
        const firstBody = first.json();
        expect(firstBody.highWatermark).toBe(3);
        expect(firstBody.entities.map((entity: { entityId: string }) => entity.entityId)).toEqual([
            "opaque-entity-1",
            "opaque-entity-2",
        ]);

        const second = await app.inject({
            method: "GET",
            url: `/v4/sessions/session-1/snapshot?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
            headers: { "x-user-id": "user-1" },
        });
        expect(second.json()).toMatchObject({
            highWatermark: 3,
            nextCursor: null,
            entities: [{ entityId: "opaque-entity-3" }],
        });

        const future = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/snapshot?cursor=4%3Aopaque-entity-1",
            headers: { "x-user-id": "user-1" },
        });
        expect(future.statusCode).toBe(400);
    });
});
