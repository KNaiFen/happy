import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const {
    state,
    dbMock,
    emitUpdateMock,
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
        tag: data.tag ?? "tag-1",
        seq: 0,
        metadata: data.metadata ?? "encrypted-metadata",
        metadataVersion: 0,
        agentState: data.agentState ?? null,
        agentStateVersion: data.agentStateVersion ?? 0,
        dataEncryptionKey: data.dataEncryptionKey ?? null,
        active: true,
        lastActiveAt: now,
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
        },
        sessionMessage: {
            findMany: vi.fn(async () => []),
        },
    };
    return {
        state,
        dbMock,
        emitUpdateMock: vi.fn(),
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
            emitEphemeral: vi.fn(),
        },
    };
});
vi.mock("@/app/session/sessionDelete", () => ({
    sessionDelete: vi.fn(async () => true),
}));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));

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

describe("sessionRoutes terminal machine origin", () => {
    let app: Fastify;

    beforeEach(() => {
        vi.clearAllMocks();
        resetState();
    });

    afterEach(async () => {
        if (app) await app.close();
    });

    it("requires a machine ID for terminal-created sessions", async () => {
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: terminalHeaders,
            payload: {
                tag: "tag-1",
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
                tag: "tag-1",
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
                tag: "tag-1",
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
            tag: "tag-1",
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
                tag: "tag-1",
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
                tag: "tag-1",
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
        });
    });
});
