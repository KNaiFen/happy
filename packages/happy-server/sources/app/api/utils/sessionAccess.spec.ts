import { describe, expect, it } from "vitest";
import { buildSessionAccessWhere } from "./sessionAccess";

describe("buildSessionAccessWhere", () => {
    it("lets an account credential address an owned session", () => {
        expect(buildSessionAccessWhere(
            { userId: "user-1" },
            { id: "session-1" },
        )).toEqual({
            id: "session-1",
            accountId: "user-1",
            account: { is: { deletionRequestedAt: null } },
        });
    });

    it("binds a terminal credential to its active origin machine", () => {
        expect(buildSessionAccessWhere(
            {
                userId: "user-1",
                credentialId: "credential-1",
                machineId: "machine-1",
            },
            { id: "session-1" },
        )).toEqual({
            id: "session-1",
            accountId: "user-1",
            account: { is: { deletionRequestedAt: null } },
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

    it("rejects an unbound terminal credential", () => {
        expect(buildSessionAccessWhere({
            userId: "user-1",
            credentialId: "credential-1",
        })).toBeNull();
    });
});
