import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
    state,
    verifyPersistentToken,
    findCredential,
    findAccount,
    createGithubState,
    verifyGithubState,
    logMock,
    resetState,
} = vi.hoisted(() => {
    const state = {
        credential: {
            responseAccountId: "user-1",
            response: "encrypted-response" as string | null,
            revokedAt: null as Date | null,
            machine: null as {
                id: string;
                accountId: string;
                deletedAt: Date | null;
            } | null,
        },
        deletionRequestedAt: null as Date | null,
    };
    const verifyPersistentToken = vi.fn(async (token: string) => (
        token === "terminal-token"
            ? {
                user: "user-1",
                extras: { credentialId: "credential-1", session: "credential-1" },
            }
            : null
    ));
    const findCredential = vi.fn(async () => ({ ...state.credential }));
    const findAccount = vi.fn(async () => ({ deletionRequestedAt: state.deletionRequestedAt }));
    const createGithubState = vi.fn(async () => "github-token");
    const verifyGithubState = vi.fn(async (): Promise<Record<string, unknown> | null> => null);
    const logMock = vi.fn();
    const resetState = () => {
        state.credential = {
            responseAccountId: "user-1",
            response: "encrypted-response",
            revokedAt: null,
            machine: null,
        };
        state.deletionRequestedAt = null;
    };
    return {
        state,
        verifyPersistentToken,
        findCredential,
        findAccount,
        createGithubState,
        verifyGithubState,
        logMock,
        resetState,
    };
});

vi.mock("privacy-kit", () => ({
    createPersistentTokenGenerator: vi.fn(async () => ({
        publicKey: new Uint8Array(32),
        new: vi.fn(async () => "created-token"),
    })),
    createPersistentTokenVerifier: vi.fn(async () => ({
        verify: verifyPersistentToken,
    })),
    createEphemeralTokenGenerator: vi.fn(async () => ({
        publicKey: new Uint8Array(32),
        new: createGithubState,
    })),
    createEphemeralTokenVerifier: vi.fn(async () => ({
        verify: verifyGithubState,
    })),
}));
vi.mock("@/storage/db", () => ({
    db: {
        terminalAuthRequest: {
            findUnique: findCredential,
        },
        account: {
            findUnique: findAccount,
        },
    },
}));
vi.mock("@/utils/log", () => ({
    log: logMock,
}));

import { AuthModule, terminalCredentialIdFromExtras } from "./auth";

describe("AuthModule terminal credential revocation", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        resetState();
        createGithubState.mockReset();
        createGithubState.mockResolvedValue("github-token");
        verifyGithubState.mockReset();
        verifyGithubState.mockResolvedValue(null);
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("normalizes both the new and legacy terminal credential claims", () => {
        expect(terminalCredentialIdFromExtras({
            credentialId: "credential-new",
            session: "credential-old",
        })).toBe("credential-new");
        expect(terminalCredentialIdFromExtras({
            session: "credential-old",
        })).toBe("credential-old");
        expect(terminalCredentialIdFromExtras({ session: "" })).toBeUndefined();
        expect(terminalCredentialIdFromExtras(null)).toBeUndefined();
    });

    it("checks the database even for a cached token and fails closed after revocation", async () => {
        const auth = new AuthModule();
        await auth.init();

        await expect(auth.verifyToken("terminal-token")).resolves.toMatchObject({
            userId: "user-1",
            credentialId: "credential-1",
        });
        await expect(auth.verifyToken("terminal-token")).resolves.toMatchObject({
            userId: "user-1",
            credentialId: "credential-1",
        });
        expect(verifyPersistentToken).toHaveBeenCalledTimes(1);
        expect(findCredential).toHaveBeenCalledTimes(2);

        state.credential.revokedAt = new Date();
        await expect(auth.verifyToken("terminal-token")).resolves.toBeNull();
        expect(findCredential).toHaveBeenCalledTimes(3);
    });

    it("rejects an already cached token as soon as account deletion is requested", async () => {
        const auth = new AuthModule();
        await auth.init();

        await expect(auth.verifyToken("terminal-token")).resolves.toMatchObject({ userId: "user-1" });
        state.deletionRequestedAt = new Date();

        await expect(auth.verifyToken("terminal-token")).resolves.toBeNull();
        expect(findAccount).toHaveBeenCalledTimes(2);
    });

    it("returns only an active machine bound to the terminal credential", async () => {
        const auth = new AuthModule();
        await auth.init();
        state.credential.machine = {
            id: "machine-1",
            accountId: "user-1",
            deletedAt: null,
        };

        await expect(auth.verifyToken("terminal-token")).resolves.toMatchObject({
            userId: "user-1",
            credentialId: "credential-1",
            machineId: "machine-1",
        });

        state.credential.machine.deletedAt = new Date();
        await expect(auth.verifyToken("terminal-token")).resolves.toBeNull();
    });

    it("fails closed without logging a hostile database error", async () => {
        const auth = new AuthModule();
        await auth.init();
        findCredential.mockRejectedValueOnce(
            new Error("prompt-reasoning-tool-output-database-secret"),
        );

        await expect(auth.verifyToken("terminal-token")).resolves.toBeNull();
        expect(JSON.stringify(logMock.mock.calls))
            .not.toContain("prompt-reasoning-tool-output-database-secret");
    });

    it("binds GitHub OAuth state to its purpose and durable admission", async () => {
        const auth = new AuthModule();
        await auth.init();

        await expect(auth.createGithubToken("user-1", "admission-1"))
            .resolves.toBe("github-token");
        expect(createGithubState).toHaveBeenCalledWith({
            user: "user-1",
            extras: {
                purpose: "github-oauth",
                admissionId: "admission-1",
            },
        });

        verifyGithubState.mockResolvedValueOnce({
            user: "user-1",
            extras: {
                purpose: "github-oauth",
                admissionId: "admission-1",
            },
        });
        await expect(auth.verifyGithubToken("valid-state")).resolves.toEqual({
            userId: "user-1",
            admissionId: "admission-1",
        });
    });

    it.each([
        ["legacy state", { user: "user-1" }],
        ["wrong purpose", { user: "user-1", extras: { purpose: "other", admissionId: "admission-1" } }],
        ["missing admission", { user: "user-1", extras: { purpose: "github-oauth" } }],
        ["empty admission", { user: "user-1", extras: { purpose: "github-oauth", admissionId: "" } }],
        ["object user", { user: { id: "user-1" }, extras: { purpose: "github-oauth", admissionId: "admission-1" } }],
        ["object admission", { user: "user-1", extras: { purpose: "github-oauth", admissionId: { id: "admission-1" } } }],
        ["object extras", { user: "user-1", extras: { nested: { purpose: "github-oauth" } } }],
    ])("rejects a %s claim", async (_name, claims) => {
        const auth = new AuthModule();
        await auth.init();
        verifyGithubState.mockResolvedValueOnce(claims);

        await expect(auth.verifyGithubToken("invalid-state")).resolves.toBeNull();
    });

    it("fails closed without logging a hostile GitHub state verifier error", async () => {
        const hostile = "prompt-reasoning-tool-output-github-state-secret";
        const auth = new AuthModule();
        await auth.init();
        verifyGithubState.mockRejectedValueOnce(new Error(hostile));

        await expect(auth.verifyGithubToken("hostile-state")).resolves.toBeNull();
        expect(JSON.stringify(logMock.mock.calls)).not.toContain(hostile);
    });
});
