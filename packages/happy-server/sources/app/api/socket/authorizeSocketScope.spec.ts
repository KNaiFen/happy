import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => ({
    dbMock: {
        machine: {
            findFirst: vi.fn(),
            updateMany: vi.fn(),
        },
        session: {
            findFirst: vi.fn(),
            updateMany: vi.fn(),
        },
    },
}));

vi.mock("@/storage/db", () => ({ db: dbMock }));

import { authorizeSocketScope } from "./authorizeSocketScope";

describe("authorizeSocketScope", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("allows account tokens but rejects terminal credentials in user scope", async () => {
        await expect(authorizeSocketScope({
            userId: "user-1",
            clientType: "user-scoped",
        })).resolves.toBe(true);
        await expect(authorizeSocketScope({
            userId: "user-1",
            credentialId: "credential-1",
            clientType: "user-scoped",
        })).resolves.toBe(false);
        expect(dbMock.machine.findFirst).not.toHaveBeenCalled();
        expect(dbMock.session.findFirst).not.toHaveBeenCalled();
    });

    it("allows a terminal credential only in its active machine scope", async () => {
        dbMock.machine.findFirst.mockResolvedValueOnce({
            credentialId: "credential-1",
        });
        await expect(authorizeSocketScope({
            userId: "user-1",
            credentialId: "credential-1",
            clientType: "machine-scoped",
            machineId: "machine-1",
        })).resolves.toBe(true);

        dbMock.machine.findFirst.mockResolvedValueOnce({
            credentialId: "credential-other",
        });
        await expect(authorizeSocketScope({
            userId: "user-1",
            credentialId: "credential-1",
            clientType: "machine-scoped",
            machineId: "machine-1",
        })).resolves.toBe(false);
    });

    it("does not let a terminal credential claim a session without a proven origin", async () => {
        dbMock.session.findFirst.mockResolvedValueOnce({
            originMachineId: null,
            originMachine: null,
        });
        dbMock.machine.findFirst.mockResolvedValueOnce({ id: "machine-1" });

        await expect(authorizeSocketScope({
            userId: "user-1",
            credentialId: "credential-1",
            clientType: "session-scoped",
            sessionId: "session-orphan",
            machineId: "machine-1",
        })).resolves.toBe(false);
        expect(dbMock.session.updateMany).not.toHaveBeenCalled();
    });
});
