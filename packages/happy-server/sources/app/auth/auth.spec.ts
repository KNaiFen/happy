import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
    state,
    verifyPersistentToken,
    findCredential,
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
    const logMock = vi.fn();
    const resetState = () => {
        state.credential = {
            responseAccountId: "user-1",
            response: "encrypted-response",
            revokedAt: null,
            machine: null,
        };
    };
    return {
        state,
        verifyPersistentToken,
        findCredential,
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
        new: vi.fn(async () => "github-token"),
    })),
    createEphemeralTokenVerifier: vi.fn(async () => ({
        verify: vi.fn(async () => null),
    })),
}));
vi.mock("@/storage/db", () => ({
    db: {
        terminalAuthRequest: {
            findUnique: findCredential,
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
});
