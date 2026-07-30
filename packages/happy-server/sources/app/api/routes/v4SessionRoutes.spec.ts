import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MAX_SYNC_V4_CIPHERTEXT_LENGTH,
    MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH,
} from "@slopus/happy-wire";
import { type Fastify } from "../types";

type SessionRecord = {
    id: string;
    accountId: string;
    syncV4Seq: number;
    originMachineId: string | null;
};

type MachineRecord = {
    id: string;
    accountId: string;
    credentialId: string | null;
    deletedAt: Date | null;
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
    contentHash: string;
    status: string;
    seq: number;
    createdAt: Date;
    prunedAt: Date | null;
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

const {
    state,
    dbMock,
    emitEphemeralMock,
    mutationMetricMock,
    operationMetricMock,
    operationDurationMetricMock,
    pageSizeMetricMock,
    prunedRecordsMetricMock,
    projectionLagMetricMock,
    snapshotFallbackMetricMock,
    resetState,
    seedSession,
} = vi.hoisted(() => {
    const state = {
        sessions: [] as SessionRecord[],
        machines: [] as MachineRecord[],
        mutations: [] as MutationRecord[],
        entities: [] as EntityRecord[],
        nextMutationId: 1,
        nextEntityId: 1,
        nowMs: 1700000000000,
    };

    const resetState = () => {
        state.sessions = [];
        state.machines = [];
        state.mutations = [];
        state.entities = [];
        state.nextMutationId = 1;
        state.nextEntityId = 1;
        state.nowMs = 1700000000000;
    };

    const seedSession = (
        id: string,
        accountId: string,
        options: { orphan?: boolean } = {},
    ) => {
        const originMachineId = options.orphan ? null : `machine-${id}`;
        if (originMachineId) {
            state.machines.push({
                id: originMachineId,
                accountId,
                credentialId: null,
                deletedAt: null,
            });
        }
        state.sessions.push({
            id,
            accountId,
            syncV4Seq: 0,
            originMachineId,
        });
    };

    const selectFields = <T extends Record<string, unknown>>(row: T, select?: Record<string, unknown>) => {
        if (!select) return { ...row };
        const result: Record<string, unknown> = {};
        for (const [key, enabled] of Object.entries(select)) {
            if (enabled) result[key] = row[key];
        }
        return result;
    };

    const sessionFindFirst = vi.fn(async (args: any) => {
        const session = state.sessions.find((candidate) => (
            candidate.id === args?.where?.id
            && candidate.accountId === args?.where?.accountId
            && (
                args?.where?.originMachineId === undefined
                || candidate.originMachineId === args.where.originMachineId
            )
            && (
                !args?.where?.originMachine?.is
                || state.machines.some((machine) => (
                    machine.id === candidate.originMachineId
                    && machine.credentialId === args.where.originMachine.is.credentialId
                    && machine.deletedAt === args.where.originMachine.is.deletedAt
                ))
            )
        ));
        if (!session) return null;
        const originMachine = state.machines.find((machine) => machine.id === session.originMachineId);
        return selectFields({
            ...session,
            originMachine: originMachine ? { deletedAt: originMachine.deletedAt } : null,
        }, args?.select);
    });

    const sessionUpdate = vi.fn(async (args: any) => {
        const session = state.sessions.find((candidate) => candidate.id === args?.where?.id);
        if (!session) throw new Error("Session not found");
        session.syncV4Seq += args?.data?.syncV4Seq?.increment ?? 0;
        return selectFields(session as unknown as Record<string, unknown>, args?.select);
    });

    const sessionUpdateMany = vi.fn(async (args: any) => {
        let count = 0;
        for (const session of state.sessions) {
            if (session.id !== args?.where?.id) continue;
            if (session.accountId !== args?.where?.accountId) continue;
            if (session.originMachineId !== args?.where?.originMachineId) continue;
            Object.assign(session, args.data);
            count += 1;
        }
        return { count };
    });

    const machineFindFirst = vi.fn(async (args: any) => (
        state.machines.find((machine) => (
            machine.id === args?.where?.id
            && machine.accountId === args?.where?.accountId
            && machine.credentialId === args?.where?.credentialId
            && machine.deletedAt === args?.where?.deletedAt
        )) ?? null
    ));

    const mutationFindMany = vi.fn(async (args: any) => {
        let rows = state.mutations.filter((mutation) => mutation.sessionId === args?.where?.sessionId);
        if (args?.where?.prunedAt === null) {
            rows = rows.filter((mutation) => mutation.prunedAt === null);
        }
        if (Array.isArray(args?.where?.mutationId?.in)) {
            const ids = new Set(args.where.mutationId.in);
            rows = rows.filter((mutation) => ids.has(mutation.mutationId));
        }
        if (typeof args?.where?.seq?.gt === "number") {
            rows = rows.filter((mutation) => mutation.seq > args.where.seq.gt);
        }
        if (typeof args?.where?.seq?.lte === "number") {
            rows = rows.filter((mutation) => mutation.seq <= args.where.seq.lte);
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
            prunedAt: args.data.prunedAt ?? null,
        };
        state.mutations.push(row);
        return selectFields(row as unknown as Record<string, unknown>, args?.select);
    });

    const mutationAggregate = vi.fn(async (args: any) => {
        let rows = state.mutations.filter((mutation) => mutation.sessionId === args?.where?.sessionId);
        if (args?.where?.prunedAt === null) {
            rows = rows.filter((mutation) => mutation.prunedAt === null);
        }
        return { _min: { seq: rows.length > 0 ? Math.min(...rows.map((mutation) => mutation.seq)) : null } };
    });

    const mutationUpdateMany = vi.fn(async (args: any) => {
        let count = 0;
        for (const mutation of state.mutations) {
            if (mutation.sessionId !== args?.where?.sessionId) continue;
            if (typeof args?.where?.seq?.lte === "number" && mutation.seq > args.where.seq.lte) continue;
            if (args?.where?.createdAt?.lt instanceof Date && mutation.createdAt >= args.where.createdAt.lt) continue;
            if (args?.where?.prunedAt === null && mutation.prunedAt !== null) continue;
            Object.assign(mutation, args.data);
            count += 1;
        }
        return { count };
    });

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
        session: {
            findFirst: sessionFindFirst,
            update: sessionUpdate,
            updateMany: sessionUpdateMany,
        },
        sessionMutationV4: {
            findMany: mutationFindMany,
            create: mutationCreate,
            aggregate: mutationAggregate,
        },
        sessionEntityV4: { findMany: entityFindMany, upsert: entityUpsert },
    };

    const dbMock = {
        session: {
            findFirst: sessionFindFirst,
            update: sessionUpdate,
            updateMany: sessionUpdateMany,
        },
        machine: { findFirst: machineFindFirst },
        sessionMutationV4: {
            findMany: mutationFindMany,
            create: mutationCreate,
            aggregate: mutationAggregate,
            updateMany: mutationUpdateMany,
        },
        sessionEntityV4: { findMany: entityFindMany, upsert: entityUpsert },
        $transaction: vi.fn(async (operation: any) => operation(txClient)),
    };

    return {
        state,
        dbMock,
        emitEphemeralMock: vi.fn(),
        mutationMetricMock: vi.fn(),
        operationMetricMock: vi.fn(),
        operationDurationMetricMock: vi.fn(),
        pageSizeMetricMock: vi.fn(),
        prunedRecordsMetricMock: vi.fn(),
        projectionLagMetricMock: vi.fn(),
        snapshotFallbackMetricMock: vi.fn(),
        resetState,
        seedSession,
    };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitEphemeral: emitEphemeralMock },
}));
vi.mock("@/app/monitoring/metrics2", () => ({
    getMetricsLabelsFromRequest: () => ({ client: "test/1.0.0", client_type: "test" }),
    getSyncV4MetricsLabelsFromRequest: () => ({ client_type: "test" }),
    syncV4MutationResultsCounter: { inc: mutationMetricMock },
    syncV4OperationsCounter: { inc: operationMetricMock },
    syncV4OperationDurationHistogram: { observe: operationDurationMetricMock },
    syncV4PageSizeHistogram: { observe: pageSizeMetricMock },
    syncV4PrunedRecordsCounter: { inc: prunedRecordsMetricMock },
    syncV4ProjectionLagHistogram: { observe: projectionLagMetricMock },
    syncV4SnapshotFallbackCounter: { inc: snapshotFallbackMetricMock },
}));

import {
    getSyncV4ClientCompatibility,
    isCodexSyncV4Enabled,
    syncV4ErrorStatus,
    v4CapabilitiesRoutes,
    v4SessionRoutes,
} from "./v4SessionRoutes";

const mutation = {
    mutationId: "mutation-1",
    producerId: "producer-1",
    entityId: "opaque-entity-1",
    entityType: "codex.item",
    revision: 1,
    op: "upsert",
    ciphertext: "encrypted-v1",
};

async function createApp(defaultHappyClient: string | null = "cli-coding-session/1.4.7"): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        if (request.headers["x-auth-error"] === "frozen") {
            throw Object.freeze(new Error("prompt-reasoning-tool-output-secret"));
        }
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") return reply.code(401).send({ error: "Unauthorized" });
        request.userId = userId;
        if (typeof request.headers["x-credential-id"] === "string") {
            request.authCredentialId = request.headers["x-credential-id"];
            request.authMachineId = state.machines.find((machine) => (
                machine.accountId === userId
                && machine.credentialId === request.authCredentialId
                && machine.deletedAt === null
            ))?.id;
        }
    });
    if (defaultHappyClient) {
        typed.addHook("onRequest", async (request) => {
            request.headers["x-happy-client"] ??= defaultHappyClient;
        });
    }
    v4CapabilitiesRoutes(typed);
    v4SessionRoutes(typed);
    await typed.ready();
    return typed;
}

describe("v4SessionRoutes", () => {
    it("keeps Codex Sync v4 disabled unless explicitly enabled", () => {
        expect(isCodexSyncV4Enabled(undefined)).toBe(false);
        expect(isCodexSyncV4Enabled("false")).toBe(false);
        expect(isCodexSyncV4Enabled("0")).toBe(false);
        expect(isCodexSyncV4Enabled("true")).toBe(true);
        expect(isCodexSyncV4Enabled("1")).toBe(true);
    });

    it("accepts only coordinated CLI and App versions on v4 data routes", async () => {
        expect(getSyncV4ClientCompatibility("cli-coding-session/1.4.7")).toEqual({ compatible: true });
        expect(getSyncV4ClientCompatibility("android/1.11.15")).toEqual({ compatible: true });
        expect(getSyncV4ClientCompatibility("cli-coding-session/1.4.6")).toEqual({
            compatible: false,
            clientType: "happy-cli",
            minimumVersion: "1.4.7",
        });
        expect(getSyncV4ClientCompatibility("test/9.0.0")).toEqual({
            compatible: false,
            clientType: "unknown",
            minimumVersion: null,
        });

        seedSession("session-1", "user-1", { orphan: true });
        app = await createApp(null);
        const response = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: {
                "x-user-id": "user-1",
                "x-happy-client": "web/1.11.14",
            },
        });
        expect(response.statusCode).toBe(426);
        expect(response.json()).toEqual({
            error: "syncV4UpgradeRequired",
            clientType: "happy-app",
            minimumVersion: "1.11.15",
        });
        expect(operationMetricMock).toHaveBeenCalledWith({
            operation: "changes",
            outcome: "invalid",
            client_type: "test",
        });
    });

    it("rejects an unauthenticated oversized mutation body before parsing it", async () => {
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "content-type": "application/json" },
            payload: JSON.stringify("x".repeat(6 * 1024 * 1024)),
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: "Unauthorized" });
        expect(operationMetricMock).toHaveBeenCalledWith({
            operation: "mutations",
            outcome: "invalid",
            client_type: "test",
        });
    });

    it("echoes a valid trace when mutation validation fails", async () => {
        app = await createApp();
        const traceId = "0123456789abcdef0123456789abcdef";
        const response = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: {
                "x-user-id": "user-1",
                "x-happy-sync-trace": traceId,
            },
            payload: { mutations: [] },
        });

        expect(response.statusCode).toBe(400);
        expect(response.headers["x-happy-sync-trace"]).toBe(traceId);
        expect(String(response.body)).not.toContain(traceId);
    });

    it("restricts terminal v4 traffic to its active machine while App tokens retain history access", async () => {
        seedSession("session-1", "user-1", { orphan: true });
        state.sessions[0].originMachineId = "machine-1";
        state.machines.push({
            id: "machine-1",
            accountId: "user-1",
            credentialId: "credential-1",
            deletedAt: null,
        });
        app = await createApp();

        const missingMachine = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: {
                "x-user-id": "user-1",
                "x-credential-id": "credential-1",
            },
        });
        expect(missingMachine.statusCode).toBe(404);

        const terminal = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: {
                "x-user-id": "user-1",
                "x-credential-id": "credential-1",
                "x-happy-machine-id": "machine-1",
            },
        });
        expect(terminal.statusCode).toBe(200);
        expect(state.sessions[0].originMachineId).toBe("machine-1");

        state.machines[0].deletedAt = new Date();
        const revokedMachine = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: {
                "x-user-id": "user-1",
                "x-credential-id": "credential-1",
                "x-happy-machine-id": "machine-1",
            },
        });
        expect(revokedMachine.statusCode).toBe(404);

        const appHistory = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: { "x-user-id": "user-1" },
        });
        expect(appHistory.statusCode).toBe(200);
    });

    it("keeps a session without a proven origin read-only to terminal credentials", async () => {
        seedSession("session-orphan", "user-1", { orphan: true });
        state.machines.push({
            id: "machine-1",
            accountId: "user-1",
            credentialId: "credential-1",
            deletedAt: null,
        });
        app = await createApp();

        const terminal = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-orphan/changes?after_seq=0",
            headers: {
                "x-user-id": "user-1",
                "x-credential-id": "credential-1",
                "x-happy-machine-id": "machine-1",
            },
        });
        const account = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-orphan/changes?after_seq=0",
            headers: { "x-user-id": "user-1" },
        });

        expect(terminal.statusCode).toBe(404);
        expect(account.statusCode).toBe(200);
        expect(state.sessions[0].originMachineId).toBeNull();
    });

    it("keeps orphaned and tombstoned sessions readable but rejects App mutations", async () => {
        seedSession("session-orphan", "user-1", { orphan: true });
        seedSession("session-deleted", "user-1");
        app = await createApp();

        const initial = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-deleted/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation] },
        });
        expect(initial.statusCode).toBe(200);

        const deletedSession = state.sessions.find((session) => session.id === "session-deleted")!;
        state.machines.find((machine) => machine.id === deletedSession.originMachineId)!.deletedAt = new Date();

        const orphanMutation = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-orphan/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [{ ...mutation, mutationId: "mutation-orphan" }] },
        });
        const deletedMutation = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-deleted/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [{ ...mutation, mutationId: "mutation-after-delete", revision: 2 }] },
        });
        const history = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-deleted/changes?after_seq=0",
            headers: { "x-user-id": "user-1" },
        });

        expect(orphanMutation.statusCode).toBe(409);
        expect(orphanMutation.json()).toEqual({ error: "sessionReadOnly" });
        expect(deletedMutation.statusCode).toBe(409);
        expect(deletedMutation.json()).toEqual({ error: "sessionReadOnly" });
        expect(history.statusCode).toBe(200);
        expect(history.json().changes).toEqual([
            expect.objectContaining({ mutationId: "mutation-1", seq: 1 }),
        ]);
        expect(deletedSession.syncV4Seq).toBe(1);
        expect(state.mutations).toHaveLength(1);
    });

    it("classifies a frozen pre-handler error without mutating it or double-counting", async () => {
        app = await createApp();
        const response = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: { "x-auth-error": "frozen" },
        });

        expect(response.statusCode).toBe(500);
        expect(operationMetricMock).toHaveBeenCalledTimes(1);
        expect(operationMetricMock).toHaveBeenCalledWith({
            operation: "changes",
            outcome: "error",
            client_type: "test",
        });
    });

    it("fails open when statusCode is exposed through a hostile getter or proxy", () => {
        const throwingGetter = Object.defineProperty(new Error("private-error"), "statusCode", {
            get: () => {
                throw new Error("prompt-reasoning-tool-output-secret");
            },
        });
        const throwingProxy = new Proxy({}, {
            get: () => {
                throw new Error("prompt-reasoning-tool-output-secret");
            },
        });

        expect(() => syncV4ErrorStatus(throwingGetter, 418)).not.toThrow();
        expect(() => syncV4ErrorStatus(throwingProxy, 200)).not.toThrow();
        expect(syncV4ErrorStatus(throwingGetter, 418)).toBe(418);
        expect(syncV4ErrorStatus(throwingProxy, 200)).toBe(500);
    });

    let app: Fastify;

    beforeEach(() => {
        resetState();
        emitEphemeralMock.mockClear();
        mutationMetricMock.mockClear();
        operationMetricMock.mockClear();
        operationDurationMetricMock.mockClear();
        pageSizeMetricMock.mockClear();
        prunedRecordsMetricMock.mockClear();
        projectionLagMetricMock.mockClear();
        snapshotFallbackMetricMock.mockClear();
        dbMock.sessionMutationV4.updateMany.mockClear();
    });

    afterEach(async () => {
        if (app) await app.close();
        vi.unstubAllEnvs();
    });

    it("advertises the coordinated compatibility set even while data routes are disabled", async () => {
        vi.stubEnv("HAPPY_CODEX_SYNC_V4_ENABLED", "false");
        app = await createApp();

        const disabled = await app.inject({ method: "GET", url: "/v4/capabilities" });
        expect(disabled.statusCode).toBe(200);
        expect(disabled.json()).toEqual({
            codex: {
                enabled: false,
                protocolVersion: 4,
                minimumHappyCliVersion: "1.4.7",
                minimumHappyAppVersion: "1.11.15",
                minimumCodexCliVersion: "0.145.0",
            },
        });

        vi.stubEnv("HAPPY_CODEX_SYNC_V4_ENABLED", "true");
        const traceId = "00000000000000000000000000000001";
        const enabled = await app.inject({
            method: "GET",
            url: "/v4/capabilities",
            headers: { "x-happy-sync-trace": traceId },
        });
        expect(enabled.json().codex.enabled).toBe(true);
        expect(enabled.headers["x-happy-sync-trace"]).toBe(traceId);
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
        expect(mutationMetricMock).toHaveBeenCalledWith({
            result: "accepted",
            client_type: "test",
        });
        expect(operationMetricMock).toHaveBeenCalledWith({
            operation: "mutations",
            outcome: "success",
            client_type: "test",
        });
        expect(pageSizeMetricMock).toHaveBeenCalledWith(
            { operation: "mutations", client_type: "test" },
            1,
        );
        expect(response.headers["x-happy-sync-trace"]).toMatch(/^[0-9a-f]{32}$/);
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
        expect(mutationMetricMock).toHaveBeenLastCalledWith(expect.objectContaining({ result: "duplicate" }));
    });

    it("prunes payloads but retains mutation receipts after crossing a cleanup boundary", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation] },
        });
        state.mutations[0].createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        const retainedContentHash = state.mutations[0].contentHash;
        state.sessions[0].syncV4Seq = 100_351;

        const response = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: {
                mutations: [
                    { ...mutation, mutationId: "mutation-2", entityId: "opaque-entity-2" },
                    { ...mutation, mutationId: "mutation-3", entityId: "opaque-entity-3" },
                ],
            },
        });

        expect(response.statusCode).toBe(200);
        expect(state.sessions[0].syncV4Seq).toBe(100_353);
        expect(dbMock.sessionMutationV4.updateMany).toHaveBeenCalledWith({
            where: {
                sessionId: "session-1",
                seq: { lte: 353 },
                createdAt: { lt: expect.any(Date) },
                prunedAt: null,
            },
            data: { ciphertext: "", prunedAt: expect.any(Date) },
        });
        expect(state.mutations[0]).toMatchObject({
            mutationId: "mutation-1",
            ciphertext: "",
            contentHash: retainedContentHash,
            prunedAt: expect.any(Date),
        });
        expect(prunedRecordsMetricMock).toHaveBeenCalledWith(
            { client_type: "test" },
            1,
        );
    });

    it("keeps committed ACKs when invalidation and prune maintenance fail", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation] },
        });
        state.mutations[0].createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        state.sessions[0].syncV4Seq = 100_351;
        emitEphemeralMock.mockImplementationOnce(() => {
            throw Object.assign(new Error("secret-invalidation-payload"), { code: "ECONNRESET" });
        });
        dbMock.sessionMutationV4.updateMany.mockRejectedValueOnce(
            Object.assign(new Error("secret-prune-payload"), { code: "EIO" }),
        );

        const response = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: {
                mutations: [
                    { ...mutation, mutationId: "mutation-2", entityId: "opaque-entity-2" },
                    { ...mutation, mutationId: "mutation-3", entityId: "opaque-entity-3" },
                ],
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().acknowledgements).toHaveLength(2);
        expect(state.sessions[0].syncV4Seq).toBe(100_353);
        expect(operationMetricMock).toHaveBeenCalledWith({
            operation: "invalidation",
            outcome: "error",
            client_type: "test",
        });
        expect(operationMetricMock).toHaveBeenCalledWith({
            operation: "prune",
            outcome: "error",
            client_type: "test",
        });
    });

    it("returns committed ACKs without waiting for slow journal maintenance", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation] },
        });
        state.mutations[0].createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        state.sessions[0].syncV4Seq = 100_351;
        let finishPrune!: (value: { count: number }) => void;
        dbMock.sessionMutationV4.updateMany.mockImplementationOnce(
            () => new Promise<{ count: number }>((resolve) => {
                finishPrune = resolve;
            }),
        );

        const response = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: {
                mutations: [
                    { ...mutation, mutationId: "mutation-2", entityId: "entity-2" },
                    { ...mutation, mutationId: "mutation-3", entityId: "entity-3" },
                ],
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().acknowledgements).toHaveLength(2);
        expect(operationMetricMock).not.toHaveBeenCalledWith(expect.objectContaining({
            operation: "prune",
        }));

        finishPrune({ count: 0 });
        await vi.waitFor(() => {
            expect(operationMetricMock).toHaveBeenCalledWith({
                operation: "prune",
                outcome: "success",
                client_type: "test",
            });
        });
    });

    it("deduplicates a pruned mutation receipt and rejects changed content", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        const request = {
            method: "POST" as const,
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation] },
        };
        await app.inject(request);
        state.mutations[0].ciphertext = "";
        state.mutations[0].prunedAt = new Date();

        const duplicate = await app.inject(request);
        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json().acknowledgements).toEqual([
            { mutationId: "mutation-1", seq: 1, revision: 1, status: "duplicate" },
        ]);

        const conflict = await app.inject({
            ...request,
            payload: { mutations: [{ ...mutation, ciphertext: "changed" }] },
        });
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json()).toEqual({ error: "mutationConflict", mutationId: "mutation-1" });
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
        expect(operationMetricMock).toHaveBeenCalledTimes(1);
        expect(operationMetricMock).toHaveBeenCalledWith({
            operation: "mutations",
            outcome: "invalid",
            client_type: "test",
        });

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
        expect(mutationMetricMock).toHaveBeenLastCalledWith(expect.objectContaining({ result: "mutation_conflict" }));
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
        expect(mutationMetricMock).toHaveBeenLastCalledWith(expect.objectContaining({ result: "revision_conflict" }));
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
        expect(projectionLagMetricMock).toHaveBeenCalledWith(
            { client_type: "test" },
            2,
        );

        const wrongOwner = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: { "x-user-id": "user-2" },
        });
        expect(wrongOwner.statusCode).toBe(404);
    });

    it("bounds changes and snapshot pages by aggregate ciphertext bytes", async () => {
        seedSession("session-1", "user-1");
        const ciphertext = "x".repeat(MAX_SYNC_V4_CIPHERTEXT_LENGTH);
        const createdAt = new Date(state.nowMs);
        for (let index = 1; index <= 17; index += 1) {
            const suffix = String(index).padStart(2, "0");
            const entityId = `opaque-entity-${suffix}`;
            state.mutations.push({
                id: `mutation-row-${suffix}`,
                sessionId: "session-1",
                mutationId: `mutation-${suffix}`,
                producerId: "producer-1",
                entityId,
                entityType: "codex.part",
                revision: 1,
                op: "upsert",
                ciphertext,
                contentHash: `content-hash-${suffix}`,
                status: "accepted",
                seq: index,
                createdAt,
                prunedAt: null,
            });
            state.entities.push({
                id: `entity-row-${suffix}`,
                sessionId: "session-1",
                producerId: "producer-1",
                entityId,
                entityType: "codex.part",
                revision: 1,
                op: "upsert",
                ciphertext,
                updatedSeq: index,
                createdAt,
                updatedAt: createdAt,
            });
        }
        state.sessions[0].syncV4Seq = 17;
        app = await createApp();

        const changes = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0&limit=100",
            headers: { "x-user-id": "user-1" },
        });
        const changesBody = changes.json();
        expect(changes.statusCode).toBe(200);
        expect(changesBody.changes).toHaveLength(16);
        expect(changesBody.changes.reduce(
            (total: number, change: { ciphertext: string }) => total + change.ciphertext.length,
            0,
        )).toBe(MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH);
        expect(changesBody.hasMore).toBe(true);

        const snapshot = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/snapshot?limit=100",
            headers: { "x-user-id": "user-1" },
        });
        const snapshotBody = snapshot.json();
        expect(snapshot.statusCode).toBe(200);
        expect(snapshotBody.entities).toHaveLength(16);
        expect(snapshotBody.entities.reduce(
            (total: number, entity: { ciphertext: string }) => total + entity.ciphertext.length,
            0,
        )).toBe(MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH);
        expect(snapshotBody.nextCursor).not.toBeNull();
    });

    it("does not return a concurrent mutation beyond the response watermark", async () => {
        seedSession("session-1", "user-1");
        app = await createApp();
        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: { mutations: [mutation] },
        });
        state.mutations.push({
            ...state.mutations[0],
            id: "mutation-row-concurrent",
            mutationId: "mutation-concurrent",
            entityId: "opaque-entity-concurrent",
            seq: 2,
        });

        const changes = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: { "x-user-id": "user-1" },
        });

        expect(changes.json()).toMatchObject({
            highWatermark: 1,
            hasMore: false,
            changes: [{ mutationId: "mutation-1", seq: 1 }],
        });
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
        expect(snapshotFallbackMetricMock).toHaveBeenCalledWith({
            reason: "journal_expired",
            client_type: "test",
        });

        state.mutations = [];
        const fullyPruned = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: { "x-user-id": "user-1" },
        });
        expect(fullyPruned.statusCode).toBe(410);
        expect(fullyPruned.json()).toEqual({ error: "snapshotRequired", minimumSeq: 3, highWatermark: 2 });
    });

    it("requires a snapshot when a retained journal page contains an internal sequence gap", async () => {
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
        state.mutations.splice(1, 1);

        const response = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=0",
            headers: { "x-user-id": "user-1" },
        });

        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({
            error: "snapshotRequired",
            minimumSeq: 3,
            highWatermark: 3,
        });
        expect(snapshotFallbackMetricMock).toHaveBeenCalledWith({
            reason: "journal_gap",
            client_type: "test",
        });
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

    it("repairs an entity updated between snapshot pages through the journal", async () => {
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

        await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/mutations",
            headers: { "x-user-id": "user-1" },
            payload: {
                mutations: [{
                    ...mutation,
                    mutationId: "mutation-4",
                    entityId: "opaque-entity-3",
                    revision: 2,
                    ciphertext: "encrypted-v2",
                }],
            },
        });

        const second = await app.inject({
            method: "GET",
            url: `/v4/sessions/session-1/snapshot?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
            headers: { "x-user-id": "user-1" },
        });
        expect(second.json()).toMatchObject({
            highWatermark: 3,
            nextCursor: null,
            entities: [],
        });

        const catchUp = await app.inject({
            method: "GET",
            url: "/v4/sessions/session-1/changes?after_seq=3",
            headers: { "x-user-id": "user-1" },
        });
        expect(catchUp.json()).toMatchObject({
            highWatermark: 4,
            changes: [{
                mutationId: "mutation-4",
                entityId: "opaque-entity-3",
                revision: 2,
                seq: 4,
            }],
        });
    });
});
