import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => ({
    dbMock: {
        machine: {
            findFirst: vi.fn(),
            updateMany: vi.fn(),
        },
        account: {
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
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock)),
}));

import { authorizeSocketScope } from "./authorizeSocketScope";

describe("authorizeSocketScope", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.account.findFirst.mockResolvedValue({ id: "user-1" });
        dbMock.account.updateMany.mockResolvedValue({ count: 1 });
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

    it("rejects user-scoped authorization while account deletion is pending", async () => {
        dbMock.account.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(authorizeSocketScope({
            userId: "user-1",
            clientType: "user-scoped",
        })).resolves.toBe(false);
        expect(dbMock.account.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "user-1", deletionRequestedAt: null },
        }));
    });
});
