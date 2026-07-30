import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";
import { ApiUpdateContainerSchema } from "../../../../../happy-app/sources/sync/apiTypes";

type MachineRow = {
    id: string;
    accountId: string;
    credentialId: string | null;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    seq: number;
    active: boolean;
    deletedAt: Date | null;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
};

type SessionRow = {
    id: string;
    accountId: string;
    originMachineId: string | null;
    active: boolean;
    lastActiveAt: Date;
};

const {
    state,
    resetState,
    dbMock,
    inTxMock,
    afterTxMock,
    allocateUserSeqMock,
    emitUpdateSpy,
    emitEphemeralSpy,
    disconnectCredentialSpy,
    disconnectMachineSpy,
    invalidateCredentialTokensSpy,
    invalidateMachineSpy,
    invalidateSessionsSpy,
} = vi.hoisted(() => {
    const now = () => new Date("2026-01-01T00:00:00.000Z");
    const emitUpdateSpy = vi.fn();
    const emitEphemeralSpy = vi.fn();
    const disconnectCredentialSpy = vi.fn();
    const disconnectMachineSpy = vi.fn();
    const invalidateCredentialTokensSpy = vi.fn();
    const invalidateMachineSpy = vi.fn();
    const invalidateSessionsSpy = vi.fn();
    const state = {
        machines: new Map<string, MachineRow>(),
        credential: null as null | {
            id: string;
            responseAccountId: string;
            response: string | null;
            revokedAt: Date | null;
            credentialVersion: number;
            machine: { id: string } | null;
        },
        sessions: [] as SessionRow[],
        accessKeys: [] as Array<{
            accountId: string;
            machineId: string;
            sessionId: string;
        }>,
        seq: 0,
    };

    const resetState = () => {
        state.machines.clear();
        state.credential = {
            id: "credential-v2",
            responseAccountId: "user-1",
            response: "encrypted-auth-response",
            revokedAt: null,
            credentialVersion: 2,
            machine: null,
        };
        state.sessions = [];
        state.accessKeys = [];
        state.seq = 0;
    };

    const machineCreate = vi.fn(async (args: any) => {
        const row: MachineRow = {
            id: args.data.id,
            accountId: args.data.accountId,
            credentialId: args.data.credentialId ?? null,
            metadata: args.data.metadata,
            metadataVersion: args.data.metadataVersion ?? 1,
            daemonState: args.data.daemonState ?? null,
            daemonStateVersion: args.data.daemonStateVersion ?? 0,
            dataEncryptionKey: args.data.dataEncryptionKey ?? null,
            seq: 7,
            active: args.data.active ?? false,
            deletedAt: null,
            lastActiveAt: now(),
            createdAt: now(),
            updatedAt: now(),
        };
        state.machines.set(row.id, row);
        if (state.credential?.id === row.credentialId) {
            state.credential.machine = { id: row.id };
        }
        return row;
    });

    const machineUpdate = vi.fn(async (args: any) => {
        const row = state.machines.get(args.where.id);
        if (!row) throw new Error("Machine not found");
        Object.assign(row, args.data, { updatedAt: now() });
        const credential = state.credential;
        if (
            typeof args.data.credentialId === "string"
            && credential
            && credential.id === args.data.credentialId
        ) {
            credential.machine = { id: row.id };
        }
        return row;
    });

    const machineFindFirst = vi.fn(async (args: any) => {
        const row = state.machines.get(args.where.id);
        if (!row || row.accountId !== args.where.accountId) return null;
        if (args.where.deletedAt === null && row.deletedAt !== null) return null;
        return row;
    });

    const machineFindMany = vi.fn(async (args: any) => (
        [...state.machines.values()].filter((row) => (
            row.accountId === args.where.accountId
            && (args.where.deletedAt !== null || row.deletedAt === null)
        ))
    ));

    const terminalAuthRequestFindFirst = vi.fn(async (args: any) => {
        const credential = state.credential;
        if (
            !credential
            || credential.id !== args.where.id
            || credential.responseAccountId !== args.where.responseAccountId
            || credential.response === null
            || credential.revokedAt !== null
        ) {
            return null;
        }
        return { ...credential };
    });

    const terminalAuthRequestUpdateMany = vi.fn(async (args: any) => {
        if (
            !state.credential
            || state.credential.id !== args.where.id
            || state.credential.responseAccountId !== args.where.responseAccountId
            || state.credential.revokedAt !== null
        ) {
            return { count: 0 };
        }
        state.credential.revokedAt = args.data.revokedAt;
        return { count: 1 };
    });

    const accessKeyFindMany = vi.fn(async (args: any) => (
        state.accessKeys
            .filter((row) => (
                row.accountId === args.where.accountId
                && row.machineId === args.where.machineId
            ))
            .map((row) => ({ sessionId: row.sessionId }))
    ));

    const accessKeyDeleteMany = vi.fn(async (args: any) => {
        const before = state.accessKeys.length;
        state.accessKeys = state.accessKeys.filter((row) => !(
            row.accountId === args.where.accountId
            && row.machineId === args.where.machineId
        ));
        return { count: before - state.accessKeys.length };
    });

    const sessionFindMany = vi.fn(async (args: any) => (
        state.sessions
            .filter((row) => (
                row.accountId === args.where.accountId
                && row.originMachineId === args.where.originMachineId
            ))
            .map((row) => ({ id: row.id }))
    ));

    const sessionUpdateMany = vi.fn(async (args: any) => {
        let count = 0;
        for (const row of state.sessions) {
            if (row.accountId !== args.where.accountId) continue;
            if (Array.isArray(args.where.id?.in) && !args.where.id.in.includes(row.id)) continue;
            if (
                Object.prototype.hasOwnProperty.call(args.where, "originMachineId")
                && row.originMachineId !== args.where.originMachineId
            ) continue;
            Object.assign(row, args.data);
            count += 1;
        }
        return { count };
    });

    const dbMock = {
        terminalAuthRequest: {
            findFirst: terminalAuthRequestFindFirst,
            updateMany: terminalAuthRequestUpdateMany,
        },
        machine: {
            findFirst: machineFindFirst,
            findMany: machineFindMany,
            findUnique: vi.fn(async (args: any) => state.machines.get(args.where.id) ?? null),
            create: machineCreate,
            update: machineUpdate,
        },
        accessKey: {
            findMany: accessKeyFindMany,
            deleteMany: accessKeyDeleteMany,
        },
        session: {
            findMany: sessionFindMany,
            updateMany: sessionUpdateMany,
        },
    };

    const afterTxMock = (tx: any, callback: () => void | Promise<void>) => {
        tx.callbacks.push(callback);
    };
    const inTxMock = async (callback: (tx: any) => Promise<unknown>) => {
        const tx = { ...dbMock, callbacks: [] as Array<() => void | Promise<void>> };
        const result = await callback(tx);
        for (const afterCommit of tx.callbacks) await afterCommit();
        return result;
    };
    const allocateUserSeqMock = vi.fn(async () => ++state.seq);

    return {
        state,
        resetState,
        dbMock,
        inTxMock,
        afterTxMock,
        allocateUserSeqMock,
        emitUpdateSpy,
        emitEphemeralSpy,
        disconnectCredentialSpy,
        disconnectMachineSpy,
        invalidateCredentialTokensSpy,
        invalidateMachineSpy,
        invalidateSessionsSpy,
    };
});

vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    return {
        ...actual,
        eventRouter: {
            emitUpdate: emitUpdateSpy,
            emitEphemeral: emitEphemeralSpy,
            disconnectCredential: disconnectCredentialSpy,
            disconnectMachine: disconnectMachineSpy,
        },
    };
});
vi.mock("@/app/auth/auth", () => ({
    auth: { invalidateCredentialTokens: invalidateCredentialTokensSpy },
}));
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        invalidateMachine: invalidateMachineSpy,
        invalidateSessions: invalidateSessionsSpy,
    },
}));
vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/storage/seq", () => ({ allocateUserSeq: allocateUserSeqMock }));
vi.mock("@/storage/inTx", () => ({ inTx: inTxMock, afterTx: afterTxMock }));
vi.mock("@/utils/log", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { machinesRoutes } from "./machinesRoutes";

function seedMachine(overrides: Partial<MachineRow> = {}): MachineRow {
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    const row: MachineRow = {
        id: "machine-1",
        accountId: "user-1",
        credentialId: null,
        metadata: "encrypted-metadata-blob",
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey: null,
        seq: 7,
        active: false,
        deletedAt: null,
        lastActiveAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...overrides,
    };
    state.machines.set(row.id, row);
    return row;
}

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
        }
    });
    machinesRoutes(typed);
    await typed.ready();
    return typed;
}

function credentialHeaders(credentialId = "credential-v2") {
    return {
        "x-user-id": "user-1",
        "x-credential-id": credentialId,
    };
}

function findEmit(type: string) {
    return emitUpdateSpy.mock.calls.find(([params]) => params?.payload?.body?.t === type)?.[0];
}

describe("machinesRoutes", () => {
    let app: Fastify;

    beforeEach(() => {
        resetState();
        vi.clearAllMocks();
    });

    afterEach(async () => {
        if (app) await app.close();
    });

    it("registers a new machine only with an approved version 2 terminal credential", async () => {
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: credentialHeaders(),
            payload: {
                id: "machine-1",
                metadata: "encrypted-metadata-blob",
                dataEncryptionKey: Buffer.from("the-data-key").toString("base64"),
            },
        });

        expect(response.statusCode).toBe(200);
        expect(state.machines.get("machine-1")?.credentialId).toBe("credential-v2");
        expect(state.credential?.machine).toEqual({ id: "machine-1" });

        const newMachine = findEmit("new-machine");
        const updateMachine = findEmit("update-machine");
        expect(newMachine).toBeDefined();
        expect(updateMachine).toBeDefined();
        expect(newMachine.recipientFilter).toEqual({ type: "user-scoped-only" });
        expect(newMachine.payload.body.dataEncryptionKey).toBeTruthy();
        expect(ApiUpdateContainerSchema.safeParse(newMachine.payload).success).toBe(true);
        expect(updateMachine.recipientFilter).toEqual({
            type: "machine-scoped-only",
            machineId: "machine-1",
        });
        expect(updateMachine.payload.body).not.toHaveProperty("dataEncryptionKey");
    });

    it("emits a valid creation update when the machine has no data encryption key", async () => {
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: credentialHeaders(),
            payload: { id: "machine-1", metadata: "encrypted-metadata-blob" },
        });

        expect(response.statusCode).toBe(200);
        const newMachine = findEmit("new-machine");
        expect(newMachine.payload.body.dataEncryptionKey).toBeNull();
        expect(ApiUpdateContainerSchema.safeParse(newMachine.payload).success).toBe(true);
    });

    it("rejects machine registration without a terminal credential", async () => {
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: { "x-user-id": "user-1" },
            payload: { id: "machine-1", metadata: "encrypted-metadata-blob" },
        });

        expect(response.statusCode).toBe(403);
        expect(state.machines.size).toBe(0);
    });

    it("lets a migrated version 1 credential bind an existing machine but not recreate a missing one", async () => {
        app = await createApp();
        state.credential!.credentialVersion = 1;

        const missing = await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: credentialHeaders(),
            payload: { id: "missing-machine", metadata: "encrypted-metadata-blob" },
        });
        expect(missing.statusCode).toBe(409);
        expect(state.machines.has("missing-machine")).toBe(false);

        seedMachine();
        const existing = await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: credentialHeaders(),
            payload: { id: "machine-1", metadata: "encrypted-metadata-blob" },
        });
        expect(existing.statusCode).toBe(200);
        expect(state.machines.get("machine-1")?.credentialId).toBe("credential-v2");
    });

    it("does not allow one terminal credential to register a second machine", async () => {
        app = await createApp();
        seedMachine({ id: "machine-existing", credentialId: "credential-v2" });
        state.credential!.machine = { id: "machine-existing" };

        const response = await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: credentialHeaders(),
            payload: { id: "machine-new", metadata: "encrypted-metadata-blob" },
        });

        expect(response.statusCode).toBe(409);
        expect(state.machines.has("machine-new")).toBe(false);
    });

    it("tombstones a machine, revokes its credential, and makes all source sessions inactive", async () => {
        app = await createApp();
        seedMachine({ credentialId: "credential-v2", active: true });
        state.credential!.machine = { id: "machine-1" };
        state.sessions = [
            {
                id: "session-from-access-key",
                accountId: "user-1",
                originMachineId: null,
                active: true,
                lastActiveAt: new Date(0),
            },
            {
                id: "session-from-origin",
                accountId: "user-1",
                originMachineId: "machine-1",
                active: true,
                lastActiveAt: new Date(0),
            },
            {
                id: "session-other-machine",
                accountId: "user-1",
                originMachineId: "machine-other",
                active: true,
                lastActiveAt: new Date(0),
            },
        ];
        state.accessKeys = [{
            accountId: "user-1",
            machineId: "machine-1",
            sessionId: "session-from-access-key",
        }];

        const response = await app.inject({
            method: "DELETE",
            url: "/v1/machines/machine-1",
            headers: { "x-user-id": "user-1" },
        });

        expect(response.statusCode).toBe(200);
        expect(state.machines.get("machine-1")?.deletedAt).toBeInstanceOf(Date);
        expect(state.machines.get("machine-1")?.active).toBe(false);
        expect(state.credential?.revokedAt).toBeInstanceOf(Date);
        expect(state.accessKeys).toEqual([]);
        expect(state.sessions[0]).toMatchObject({
            originMachineId: "machine-1",
            active: false,
        });
        expect(state.sessions[1].active).toBe(false);
        expect(state.sessions[2].active).toBe(true);
        expect(findEmit("delete-machine")).toBeDefined();
        expect(invalidateCredentialTokensSpy).toHaveBeenCalledWith("credential-v2");
        expect(disconnectCredentialSpy).toHaveBeenCalledWith("user-1", "credential-v2");
        expect(disconnectMachineSpy).toHaveBeenCalledWith("user-1", "machine-1");
        expect(invalidateMachineSpy).toHaveBeenCalledWith("machine-1");
        expect(invalidateSessionsSpy).toHaveBeenCalledWith(expect.arrayContaining([
            "session-from-access-key",
            "session-from-origin",
        ]));
    });

    it("does not let a terminal credential delete machines", async () => {
        app = await createApp();
        seedMachine({ credentialId: "credential-v2", active: true });

        const response = await app.inject({
            method: "DELETE",
            url: "/v1/machines/machine-1",
            headers: credentialHeaders(),
        });

        expect(response.statusCode).toBe(403);
        expect(state.machines.get("machine-1")?.deletedAt).toBeNull();
    });

    it("keeps deletion idempotent and prevents the revoked credential from reviving the device", async () => {
        app = await createApp();
        seedMachine({ credentialId: "credential-v2", active: true });
        state.credential!.machine = { id: "machine-1" };

        const firstDelete = await app.inject({
            method: "DELETE",
            url: "/v1/machines/machine-1",
            headers: { "x-user-id": "user-1" },
        });
        const deleteEmitCount = emitUpdateSpy.mock.calls.length;
        const secondDelete = await app.inject({
            method: "DELETE",
            url: "/v1/machines/machine-1",
            headers: { "x-user-id": "user-1" },
        });
        const revive = await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: credentialHeaders(),
            payload: { id: "machine-1", metadata: "encrypted-metadata-blob" },
        });

        expect(firstDelete.statusCode).toBe(200);
        expect(secondDelete.statusCode).toBe(200);
        expect(emitUpdateSpy.mock.calls).toHaveLength(deleteEmitCount);
        expect(revive.statusCode).toBe(401);
        expect(state.machines.get("machine-1")?.deletedAt).toBeInstanceOf(Date);
    });
});
