import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const {
    state,
    upsertAuthRequest,
    accountAuthUpsert,
    createToken,
    isAccountActive,
    terminalAuthFindUnique,
    terminalAuthUpdateMany,
    accountAuthFindUnique,
    accountAuthUpdateMany,
    accountUpdateMany,
    accountCreateMany,
    dbMock,
} = vi.hoisted(() => {
    const state = {
        authorized: false,
        revoked: false,
        accountWritable: true,
        upsertArgs: null as any,
        terminalResponse: null as string | null,
        terminalOwner: null as string | null,
        accountResponse: null as string | null,
        accountOwner: null as string | null,
    };
    const terminalRecord = () => ({
        id: "credential-1",
        publicKey: "terminal-public-key",
        supportsV2: true,
        credentialVersion: 2,
        response: state.terminalResponse,
        responseAccountId: state.terminalOwner,
        revokedAt: state.revoked ? new Date() : null,
    });
    const upsertAuthRequest = vi.fn(async (args: any) => {
        state.upsertArgs = args;
        return {
            ...terminalRecord(),
            publicKey: args.create.publicKey,
            supportsV2: args.create.supportsV2,
            credentialVersion: args.create.credentialVersion,
            response: state.authorized ? "encrypted-response" : state.terminalResponse,
            responseAccountId: state.authorized ? "user-1" : state.terminalOwner,
        };
    });
    const terminalAuthFindUnique = vi.fn(async () => terminalRecord());
    const terminalAuthUpdateMany = vi.fn(async (args: any) => {
        if (state.revoked || state.terminalResponse || state.terminalOwner) {
            return { count: 0 };
        }
        state.terminalResponse = args.data.response;
        state.terminalOwner = args.data.responseAccountId;
        return { count: 1 };
    });
    const accountRecord = () => ({
        id: "account-request-1",
        publicKey: "account-public-key",
        response: state.accountResponse,
        responseAccountId: state.accountOwner,
    });
    const accountAuthFindUnique = vi.fn(async () => accountRecord());
    const accountAuthUpsert = vi.fn(async (args: any) => ({
        ...accountRecord(),
        publicKey: args.create.publicKey,
    }));
    const accountAuthUpdateMany = vi.fn(async (args: any) => {
        if (state.accountResponse || state.accountOwner) {
            return { count: 0 };
        }
        state.accountResponse = args.data.response;
        state.accountOwner = args.data.responseAccountId;
        return { count: 1 };
    });
    const accountUpdateMany = vi.fn(async () => ({ count: state.accountWritable ? 1 : 0 }));
    const accountCreateMany = vi.fn(async () => ({ count: 1 }));
    const dbMock = {
        terminalAuthRequest: {
            upsert: upsertAuthRequest,
            findUnique: terminalAuthFindUnique,
            update: vi.fn(),
            updateMany: terminalAuthUpdateMany,
        },
        account: {
            upsert: vi.fn(),
            createMany: accountCreateMany,
            updateMany: accountUpdateMany,
            findUniqueOrThrow: vi.fn(async () => ({ id: "user-1" })),
        },
        accountAuthRequest: {
            upsert: accountAuthUpsert,
            findUnique: accountAuthFindUnique,
            update: vi.fn(),
            updateMany: accountAuthUpdateMany,
        },
    };
    return {
        state,
        upsertAuthRequest,
        accountAuthUpsert,
        createToken: vi.fn(async () => "terminal-token"),
        isAccountActive: vi.fn(async () => true),
        terminalAuthFindUnique,
        terminalAuthUpdateMany,
        accountAuthFindUnique,
        accountAuthUpdateMany,
        accountUpdateMany,
        accountCreateMany,
        dbMock,
    };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/storage/inTx", () => ({
    inTx: async (callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock),
}));
vi.mock("@/app/auth/auth", () => ({
    auth: { createToken, isAccountActive },
}));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));

import { authRoutes } from "./authRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate("authenticate", async (request: any) => {
        request.userId = request.headers["x-user-id"] ?? "user-1";
        if (request.headers["x-terminal-credential"] === "true") {
            request.authCredentialId = "credential-1";
        }
    });
    authRoutes(typed);
    await typed.ready();
    return typed;
}

describe("authRoutes terminal credential lifecycle", () => {
    let app: Fastify;
    const publicKey = Buffer.alloc(32, 7).toString("base64");

    beforeEach(() => {
        vi.clearAllMocks();
        state.authorized = false;
        state.revoked = false;
        state.accountWritable = true;
        state.upsertArgs = null;
        state.terminalResponse = null;
        state.terminalOwner = null;
        state.accountResponse = null;
        state.accountOwner = null;
        upsertAuthRequest.mockClear();
        accountAuthUpsert.mockClear();
        accountUpdateMany.mockClear();
        accountCreateMany.mockClear();
    });

    afterEach(async () => {
        if (app) await app.close();
    });

    it("creates new QR credentials at lifecycle version 2", async () => {
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey, supportsV2: true },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ state: "requested" });
        expect(state.upsertArgs.create).toMatchObject({
            supportsV2: true,
            credentialVersion: 2,
        });
    });

    it("puts the stable credential ID in both new and legacy token claims", async () => {
        app = await createApp();
        state.authorized = true;
        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey, supportsV2: true },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            state: "authorized",
            token: "terminal-token",
        });
        expect(createToken).toHaveBeenCalledWith("user-1", {
            credentialId: "credential-1",
            session: "credential-1",
        });
    });

    it("does not return a fresh terminal token while the account is deleting", async () => {
        app = await createApp();
        state.authorized = true;
        isAccountActive.mockResolvedValueOnce(false);

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey, supportsV2: true },
        });

        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({ error: "Account deletion in progress" });
        expect(createToken).not.toHaveBeenCalled();
    });

    it.each([
        {
            url: "/v1/auth/request",
            owner: () => { state.terminalOwner = "user-1"; },
            upsert: () => upsertAuthRequest,
        },
        {
            url: "/v1/auth/account/request",
            owner: () => { state.accountOwner = "user-1"; },
            upsert: () => accountAuthUpsert,
        },
    ])("does not mutate an auth request owned by an account being deleted at $url", async ({ url, owner, upsert }) => {
        app = await createApp();
        owner();
        state.accountWritable = false;

        const response = await app.inject({
            method: "POST",
            url,
            payload: { publicKey, supportsV2: true },
        });

        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({ error: "Account deletion in progress" });
        expect(upsert()).not.toHaveBeenCalled();
        expect(createToken).not.toHaveBeenCalled();
    });

    it("does not reissue a token for a revoked QR credential", async () => {
        app = await createApp();
        state.authorized = true;
        state.revoked = true;
        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey, supportsV2: true },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: "Credential revoked" });
        expect(createToken).not.toHaveBeenCalled();
    });

    it.each([
        "/v1/auth/response",
        "/v1/auth/account/response",
    ])("does not let a terminal credential approve %s", async (url) => {
        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url,
            headers: { "x-terminal-credential": "true" },
            payload: {
                publicKey,
                response: "encrypted-response",
            },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: "Account credential required" });
    });

    it.each([
        {
            url: "/v1/auth/response",
            owner: () => state.terminalOwner,
        },
        {
            url: "/v1/auth/account/response",
            owner: () => state.accountOwner,
        },
    ])("atomically assigns one account owner for concurrent approval at $url", async ({ url, owner }) => {
        app = await createApp();
        const approve = (userId: string) => app.inject({
            method: "POST",
            url,
            headers: { "x-user-id": userId },
            payload: {
                publicKey,
                response: `encrypted-for-${userId}`,
            },
        });

        const responses = await Promise.all([
            approve("user-1"),
            approve("user-2"),
        ]);

        expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
        expect(["user-1", "user-2"]).toContain(owner());
        const winningUser = owner()!;
        const retry = await approve(winningUser);
        expect(retry.statusCode).toBe(200);
    });

    it.each([
        "/v1/auth/response",
        "/v1/auth/account/response",
    ])("rejects %s while the approving account is deleting", async (url) => {
        app = await createApp();
        state.accountWritable = false;

        const response = await app.inject({
            method: "POST",
            url,
            headers: { "x-user-id": "user-1" },
            payload: {
                publicKey,
                response: "encrypted-response",
            },
        });

        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({ error: "Account deletion in progress" });
        expect(terminalAuthUpdateMany).not.toHaveBeenCalled();
        expect(accountAuthUpdateMany).not.toHaveBeenCalled();
    });
});
