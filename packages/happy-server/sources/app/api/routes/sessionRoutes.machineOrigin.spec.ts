import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const {
    state,
    dbMock,
    emitUpdateMock,
    emitEphemeralMock,
    invalidateSessionsMock,
    resetState,
    row,
} = vi.hoisted(() => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const state = {
        machineAuthorized: true,
        existingSession: null as any,
        createdData: null as any,
        listSessions: [] as any[],
    };
    const resetState = () => {
        state.machineAuthorized = true;
        state.existingSession = null;
        state.createdData = null;
        state.listSessions = [];
    };
    const row = (data: any) => ({
        id: data.id ?? "session-1",
        accountId: data.accountId ?? "user-1",
        tag: data.tag ?? "codex-gateway-root-v1-test",
        seq: 0,
        metadata: data.metadata ?? "encrypted-metadata",
        metadataVersion: 0,
        agentState: data.agentState ?? null,
        agentStateVersion: data.agentStateVersion ?? 0,
        dataEncryptionKey: data.dataEncryptionKey ?? null,
        active: data.active ?? true,
        archivedAt: data.archivedAt ?? null,
        presenceLeaseId: data.presenceLeaseId ?? null,
        lastActiveAt: data.lastActiveAt ?? now,
        createdAt: now,
        updatedAt: now,
        originMachineId: data.originMachineId ?? null,
        originMachine: data.originMachine ?? (
            data.originMachineId
                ? { deletedAt: null }
                : null
        ),
    });
    const dbMock = {
        machine: {
            findFirst: vi.fn(async () => (
                state.machineAuthorized ? { id: "machine-1" } : null
            )),
        },
        session: {
            findFirst: vi.fn(async () => state.existingSession),
            findMany: vi.fn(async () => state.listSessions),
            create: vi.fn(async (args: any) => {
                state.createdData = args.data;
                return row(args.data);
            }),
            update: vi.fn(async (args: any) => {
                state.existingSession = row({
                    ...state.existingSession,
                    ...args.data,
                });
                return state.existingSession;
            }),
            updateMany: vi.fn(async (args: any) => {
                const session = state.existingSession;
                if (!session || (args.where?.id && args.where.id !== session.id)) return { count: 0 };
                if (args.where?.archivedAt === null && session.archivedAt !== null) return { count: 0 };
                if (args.where?.active !== undefined && args.where.active !== session.active) return { count: 0 };
                if (
                    args.where?.presenceLeaseId !== undefined
                    && args.where.presenceLeaseId !== session.presenceLeaseId
                ) return { count: 0 };
                if (
                    args.where?.lastActiveAt
                    && args.where.lastActiveAt.getTime() !== session.lastActiveAt.getTime()
                ) return { count: 0 };
                Object.assign(session, args.data);
                return { count: 1 };
            }),
        },
        sessionMessage: {
            findMany: vi.fn(async () => []),
        },
    };
    return {
        state,
        dbMock,
        emitUpdateMock: vi.fn(),
        emitEphemeralMock: vi.fn(),
        invalidateSessionsMock: vi.fn(),
        resetState,
        row,
    };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/storage/inTx", () => ({
    inTx: async (callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock),
}));
vi.mock("@/storage/seq", () => ({ allocateUserSeq: vi.fn(async () => 1) }));
vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    return {
        ...actual,
        eventRouter: {
            emitUpdate: emitUpdateMock,
            emitEphemeral: emitEphemeralMock,
        },
    };
});
vi.mock("@/app/session/sessionDelete", () => ({
    sessionDelete: vi.fn(async () => true),
}));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: { invalidateSessions: invalidateSessionsMock },
}));

import { sessionRoutes } from "./sessionRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
        if (typeof request.headers["x-credential-id"] === "string") {
            request.authCredentialId = request.headers["x-credential-id"];
            request.authMachineId = state.machineAuthorized ? "machine-1" : undefined;
        }
    });
    sessionRoutes(typed);
    await typed.ready();
    return typed;
}

const terminalHeaders = {
    "x-user-id": "user-1",
    "x-credential-id": "credential-1",
};

const supportedTag = "codex-gateway-root-v1-test";

describe("sessionRoutes terminal machine origin", () => {
    let app: Fastify;

    beforeEach(() => {
        vi.clearAllMocks();
        resetState();
    });

    afterEach(async () => {
        if (app) await app.close();
    });

    it("rejects unsupported session tags", async () => {
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: terminalHeaders,
            payload: {
                tag: "legacy-provider-session",
                metadata: "encrypted-metadata",
                machineId: "machine-1",
            },
        });

        expect(response.statusCode).toBe(400);
        expect(state.createdData).toBeNull();
    });

    it("requires a machine ID for terminal-created sessions", async () => {
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: terminalHeaders,
            payload: {
                tag: supportedTag,
                metadata: "encrypted-metadata",
            },
        });

        expect(response.statusCode).toBe(400);
        expect(state.createdData).toBeNull();
    });

    it("rejects a machine that is not bound to the terminal credential", async () => {
        app = await createApp();
        state.machineAuthorized = false;
        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: terminalHeaders,
            payload: {
                tag: supportedTag,
                metadata: "encrypted-metadata",
                machineId: "machine-1",
            },
        });

        expect(response.statusCode).toBe(403);
        expect(state.createdData).toBeNull();
    });

    it("persists the machine origin and initial agent state on creation", async () => {
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: terminalHeaders,
            payload: {
                tag: supportedTag,
                metadata: "encrypted-metadata",
                agentState: "encrypted-agent-state",
                machineId: "machine-1",
            },
        });

        expect(response.statusCode).toBe(200);
        expect(state.createdData).toMatchObject({
            originMachineId: "machine-1",
            agentState: "encrypted-agent-state",
            agentStateVersion: 1,
        });
        expect(response.json().session).toMatchObject({
            originMachineId: "machine-1",
            machineDeletedAt: null,
        });
        expect(emitUpdateMock).toHaveBeenCalledOnce();
    });

    it("does not let a terminal credential take over a session from another machine", async () => {
        app = await createApp();
        state.existingSession = {
            id: "session-1",
            accountId: "user-1",
            tag: supportedTag,
            seq: 0,
            metadata: "encrypted-metadata",
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            originMachineId: "machine-other",
            originMachine: { deletedAt: null },
        };

        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: terminalHeaders,
            payload: {
                tag: supportedTag,
                metadata: "encrypted-metadata",
                machineId: "machine-1",
            },
        });

        expect(response.statusCode).toBe(409);
        expect(state.existingSession.originMachineId).toBe("machine-other");
    });

    it("does not let a terminal credential claim an orphaned session", async () => {
        app = await createApp();
        state.existingSession = row({
            id: "session-orphan",
            originMachineId: null,
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: terminalHeaders,
            payload: {
                tag: supportedTag,
                metadata: "encrypted-metadata",
                machineId: "machine-1",
            },
        });

        expect(response.statusCode).toBe(409);
        expect(state.existingSession.originMachineId).toBeNull();
    });

    it("returns the origin tombstone to the App while preserving session history", async () => {
        app = await createApp();
        state.listSessions = [{
            id: "session-1",
            seq: 0,
            metadata: "encrypted-metadata",
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            active: false,
            lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            originMachineId: "machine-1",
            originMachine: {
                deletedAt: new Date("2026-01-02T00:00:00.000Z"),
            },
        }];

        const response = await app.inject({
            method: "GET",
            url: "/v1/sessions",
            headers: { "x-user-id": "user-1" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().sessions[0]).toMatchObject({
            id: "session-1",
            originMachineId: "machine-1",
            machineDeletedAt: new Date("2026-01-02T00:00:00.000Z").getTime(),
            archivedAt: null,
        });
    });

    it("serializes archivedAt in every session list response", async () => {
        app = await createApp();
        const archivedAt = new Date("2026-01-03T00:00:00.000Z");
        state.listSessions = [row({ id: "session-archived", active: false, archivedAt })];

        for (const url of ["/v1/sessions", "/v2/sessions/active", "/v2/sessions"]) {
            const response = await app.inject({
                method: "GET",
                url,
                headers: { "x-user-id": "user-1" },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().sessions[0]).toMatchObject({
                id: "session-archived",
                archivedAt: archivedAt.getTime(),
            });
        }
    });

    it("filters paginated account history by machine without changing the cursor contract", async () => {
        app = await createApp();
        state.listSessions = [
            row({ id: "session-2", originMachineId: "machine-1" }),
            row({ id: "session-1", originMachineId: "machine-1" }),
        ];

        const response = await app.inject({
            method: "GET",
            url: "/v2/sessions?originMachineId=machine-1&cursor=cursor_v1_session-3&limit=1",
            headers: { "x-user-id": "user-1" },
        });

        expect(response.statusCode).toBe(200);
        expect(dbMock.session.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
            where: {
                accountId: "user-1",
                originMachineId: "machine-1",
                id: { lt: "session-3" },
            },
            take: 2,
        }));
        expect(response.json()).toMatchObject({
            sessions: [expect.objectContaining({ id: "session-2" })],
            hasNext: true,
            nextCursor: "cursor_v1_session-2",
        });
    });

    it("keeps deleted-machine tombstones in filtered account history", async () => {
        app = await createApp();
        state.listSessions = [row({
            id: "session-deleted-machine",
            originMachineId: "machine-1",
            originMachine: { deletedAt: new Date("2026-01-02T00:00:00.000Z") },
        })];

        const response = await app.inject({
            method: "GET",
            url: "/v2/sessions?originMachineId=machine-1",
            headers: { "x-user-id": "user-1" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().sessions[0]).toMatchObject({
            id: "session-deleted-machine",
            machineDeletedAt: new Date("2026-01-02T00:00:00.000Z").getTime(),
        });
    });

    it("rejects terminal history queries for another machine", async () => {
        app = await createApp();

        const response = await app.inject({
            method: "GET",
            url: "/v2/sessions?originMachineId=machine-other",
            headers: terminalHeaders,
        });

        expect(response.statusCode).toBe(403);
        expect(dbMock.session.findMany).not.toHaveBeenCalled();
    });

    it("archives idempotently and invalidates queued activity", async () => {
        app = await createApp();
        state.existingSession = row({
            id: "session-1",
            originMachineId: "machine-1",
            presenceLeaseId: "11111111-1111-4111-8111-111111111111",
        });

        const first = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/archive",
            headers: { "x-user-id": "user-1" },
        });
        const archivedAt = state.existingSession.archivedAt as Date;
        const second = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/archive",
            headers: { "x-user-id": "user-1" },
        });

        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({
            success: true,
            archivedAt: archivedAt.getTime(),
            alreadyArchived: false,
        });
        expect(second.json()).toEqual({
            success: true,
            archivedAt: archivedAt.getTime(),
            alreadyArchived: true,
        });
        expect(state.existingSession.active).toBe(false);
        expect(state.existingSession.presenceLeaseId).toBeNull();
        expect(invalidateSessionsMock).toHaveBeenCalledTimes(2);
        expect(emitEphemeralMock).toHaveBeenCalledTimes(2);
        expect(emitEphemeralMock.mock.calls.map(([event]) => event.payload)).toEqual([
            expect.objectContaining({ active: false, activeAt: archivedAt.getTime(), archivedAt: archivedAt.getTime() }),
            expect.objectContaining({ active: false, activeAt: archivedAt.getTime(), archivedAt: archivedAt.getTime() }),
        ]);
    });

    it("lets a new Gateway claim an inactive session and rejects the superseded lease", async () => {
        app = await createApp();
        state.existingSession = row({
            id: "session-1",
            originMachineId: "machine-1",
            active: false,
            lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
        });
        const firstLease = "11111111-1111-4111-8111-111111111111";
        const secondLease = "22222222-2222-4222-8222-222222222222";

        const claimed = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/presence/claim",
            headers: terminalHeaders,
            payload: { leaseId: firstLease },
        });
        const takenOver = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/presence/claim",
            headers: terminalHeaders,
            payload: { leaseId: secondLease },
        });
        const oldTouch = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/presence/touch",
            headers: terminalHeaders,
            payload: { leaseId: firstLease },
        });
        const oldRelease = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/presence/release",
            headers: terminalHeaders,
            payload: { leaseId: firstLease },
        });

        expect(claimed.statusCode).toBe(200);
        expect(takenOver.statusCode).toBe(200);
        expect(state.existingSession).toMatchObject({ active: true, presenceLeaseId: secondLease });
        expect(oldTouch.statusCode).toBe(409);
        expect(oldTouch.json()).toEqual({ error: "presenceLeaseSuperseded" });
        expect(oldRelease.statusCode).toBe(409);
        expect(oldRelease.json()).toEqual({ error: "presenceLeaseSuperseded" });
        expect(emitEphemeralMock).toHaveBeenCalledOnce();
        expect(emitEphemeralMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ active: true, archivedAt: null }),
        }));
    });

    it("releases only its current lease without archiving the session", async () => {
        app = await createApp();
        const leaseId = "11111111-1111-4111-8111-111111111111";
        state.existingSession = row({
            id: "session-1",
            originMachineId: "machine-1",
            presenceLeaseId: leaseId,
        });

        const response = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/presence/release",
            headers: terminalHeaders,
            payload: { leaseId },
        });

        expect(response.statusCode).toBe(200);
        expect(state.existingSession).toMatchObject({
            active: false,
            archivedAt: null,
            presenceLeaseId: null,
        });
        expect(emitEphemeralMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ active: false, archivedAt: null }),
        }));
    });

    it("rejects machine-less presence requests and cannot claim an archive tombstone", async () => {
        app = await createApp();
        const leaseId = "11111111-1111-4111-8111-111111111111";
        state.existingSession = row({
            id: "session-1",
            originMachineId: "machine-1",
            archivedAt: new Date("2026-01-02T00:00:00.000Z"),
        });

        const accountAttempt = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/presence/claim",
            headers: { "x-user-id": "user-1" },
            payload: { leaseId },
        });
        const tombstoneAttempt = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/presence/claim",
            headers: terminalHeaders,
            payload: { leaseId },
        });

        expect(accountAttempt.statusCode).toBe(403);
        expect(tombstoneAttempt.statusCode).toBe(409);
        expect(tombstoneAttempt.json()).toEqual({ error: "sessionArchived" });
        expect(state.existingSession).toMatchObject({ active: true, archivedAt: expect.any(Date) });
    });

    it("allows only the original terminal machine to unarchive", async () => {
        app = await createApp();
        const archivedAt = new Date(Date.now() + 10_000);
        state.existingSession = row({
            id: "session-1",
            originMachineId: "machine-1",
            archivedAt,
            lastActiveAt: archivedAt,
        });

        const accountAttempt = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/unarchive",
            headers: { "x-user-id": "user-1" },
        });
        const terminalAttempt = await app.inject({
            method: "POST",
            url: "/v4/sessions/session-1/unarchive",
            headers: terminalHeaders,
        });

        expect(accountAttempt.statusCode).toBe(403);
        expect(terminalAttempt.statusCode).toBe(200);
        expect(terminalAttempt.json()).toMatchObject({
            success: true,
            alreadyUnarchived: false,
        });
        expect(terminalAttempt.json().activeAt).toBe(archivedAt.getTime() + 1);
        expect(state.existingSession.archivedAt).toBeNull();
        expect(state.existingSession.active).toBe(false);
        expect(state.existingSession.presenceLeaseId).toBeNull();
        expect(state.existingSession.lastActiveAt.getTime()).toBe(archivedAt.getTime() + 1);
        expect(invalidateSessionsMock).toHaveBeenCalledWith(["session-1"]);
        expect(emitEphemeralMock).toHaveBeenLastCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ active: false, activeAt: archivedAt.getTime() + 1, archivedAt: null }),
        }));
    });

    it("does not load an archived tag as a new terminal session", async () => {
        app = await createApp();
        state.existingSession = row({
            id: "session-1",
            originMachineId: "machine-1",
            archivedAt: new Date("2026-01-02T00:00:00.000Z"),
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: terminalHeaders,
            payload: {
                tag: supportedTag,
                metadata: "encrypted-metadata",
                machineId: "machine-1",
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: "sessionArchived" });
    });
});
