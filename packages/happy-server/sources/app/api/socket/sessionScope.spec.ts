import { describe, expect, it } from "vitest";
import { sessionWhereForConnection } from "./sessionScope";

const socket = {} as never;

describe("sessionWhereForConnection", () => {
    it("keeps an account socket account-scoped", () => {
        expect(sessionWhereForConnection(
            "user-1",
            { connectionType: "user-scoped", socket, userId: "user-1" },
            "session-1",
        )).toEqual({
            id: "session-1",
            accountId: "user-1",
        });
    });

    it("binds a terminal session socket to its own session and machine", () => {
        expect(sessionWhereForConnection(
            "user-1",
            {
                connectionType: "session-scoped",
                socket,
                userId: "user-1",
                sessionId: "session-1",
                machineId: "machine-1",
                credentialId: "credential-1",
            },
            "session-1",
        )).toEqual({
            id: "session-1",
            accountId: "user-1",
            originMachineId: "machine-1",
            originMachine: {
                is: {
                    accountId: "user-1",
                    credentialId: "credential-1",
                    deletedAt: null,
                },
            },
        });
    });

    it("rejects a terminal socket targeting another session", () => {
        expect(sessionWhereForConnection(
            "user-1",
            {
                connectionType: "session-scoped",
                socket,
                userId: "user-1",
                sessionId: "session-1",
                machineId: "machine-1",
                credentialId: "credential-1",
            },
            "session-2",
        )).toBeNull();
    });
});
