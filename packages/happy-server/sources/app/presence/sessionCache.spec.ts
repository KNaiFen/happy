import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
    dbMock,
    counterIncMock,
    acquireAccountWriteMock,
    resetMocks,
} = vi.hoisted(() => {
    const dbMock = {
        session: {
            findFirst: vi.fn(),
            updateMany: vi.fn(),
        },
        machine: {
            findFirst: vi.fn(),
            updateMany: vi.fn(),
        },
    };
    const counterIncMock = vi.fn();
    const acquireAccountWriteMock = vi.fn(async () => true);
    const resetMocks = () => {
        dbMock.session.findFirst.mockReset();
        dbMock.session.updateMany.mockReset();
        dbMock.machine.findFirst.mockReset();
        dbMock.machine.updateMany.mockReset();
        counterIncMock.mockReset();
        acquireAccountWriteMock.mockReset();
        acquireAccountWriteMock.mockResolvedValue(true);
    };
    return { dbMock, counterIncMock, acquireAccountWriteMock, resetMocks };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/storage/inTx", () => ({
    inTx: async (callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock),
}));
vi.mock("@/app/account/accountWriteGate", () => ({
    acquireAccountWrite: acquireAccountWriteMock,
}));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/app/monitoring/metrics2", () => ({
    sessionCacheCounter: { inc: counterIncMock },
    databaseUpdatesSkippedCounter: { inc: counterIncMock },
}));

describe("ActivityCache machine heartbeats", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        resetMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("persists active=true for a fresh inactive machine heartbeat", async () => {
        const now = Date.parse("2026-01-01T00:00:00.000Z");
        vi.setSystemTime(now);
        dbMock.machine.findFirst.mockResolvedValue({
            id: "machine-1",
            accountId: "user-1",
            active: false,
            lastActiveAt: new Date(now),
        });
        dbMock.machine.updateMany.mockResolvedValue({ count: 1 });

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isMachineValid("machine-1", "user-1")).resolves.toBe(true);
        expect(activityCache.queueMachineUpdate("machine-1", now + 1000)).toBe(true);

        await vi.advanceTimersByTimeAsync(5000);

        expect(dbMock.machine.updateMany).toHaveBeenCalledWith({
            where: {
                accountId: "user-1",
                account: { deletionRequestedAt: null },
                id: "machine-1",
                deletedAt: null,
            },
            data: {
                lastActiveAt: new Date(now + 1000),
                active: true,
            },
        });

        activityCache.shutdown();
    });

    it("does not cache or revive a deleted machine", async () => {
        dbMock.machine.findFirst.mockResolvedValue(null);

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isMachineValid("machine-deleted", "user-1")).resolves.toBe(false);
        expect(dbMock.machine.findFirst).toHaveBeenCalledWith({
            where: {
                account: { is: { deletionRequestedAt: null } },
                accountId: "user-1",
                id: "machine-deleted",
                deletedAt: null,
            },
        });
        expect(activityCache.queueMachineUpdate("machine-deleted", Date.now())).toBe(false);
        expect(dbMock.machine.updateMany).not.toHaveBeenCalled();

        activityCache.shutdown();
    });

    it("persists a session heartbeat only while the archive tombstone is absent", async () => {
        const now = Date.parse("2026-01-01T00:00:00.000Z");
        vi.setSystemTime(now);
        dbMock.session.findFirst.mockResolvedValue({
            id: "session-1",
            accountId: "user-1",
            lastActiveAt: new Date(now - 60_000),
        });
        dbMock.session.updateMany.mockResolvedValue({ count: 0 });

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isSessionValid("session-1", "user-1")).resolves.toBe(true);
        expect(activityCache.queueSessionUpdate("session-1", now)).toBe(true);
        await vi.advanceTimersByTimeAsync(5000);

        expect(dbMock.session.findFirst).toHaveBeenCalledWith({
            where: {
                account: { is: { deletionRequestedAt: null } },
                id: "session-1",
                accountId: "user-1",
                archivedAt: null,
            },
        });
        expect(dbMock.session.updateMany).toHaveBeenCalledWith({
            where: {
                id: "session-1",
                accountId: "user-1",
                account: { deletionRequestedAt: null },
                active: true,
                archivedAt: null,
                presenceLeaseId: null,
                OR: [
                    { originMachineId: null },
                    { originMachine: { deletedAt: null } },
                ],
            },
            data: {
                lastActiveAt: new Date(now),
                active: true,
            },
        });

        activityCache.shutdown();
    });

    it("drops stale cached writes once the account deletion gate closes", async () => {
        const now = Date.parse("2026-01-01T00:00:00.000Z");
        vi.setSystemTime(now);
        dbMock.session.findFirst.mockResolvedValue({
            id: "session-1",
            accountId: "user-1",
            lastActiveAt: new Date(now - 60_000),
        });
        dbMock.machine.findFirst.mockResolvedValue({
            id: "machine-1",
            accountId: "user-1",
            active: false,
            lastActiveAt: new Date(now - 60_000),
        });

        const { activityCache } = await import("./sessionCache");
        await activityCache.isSessionValid("session-1", "user-1");
        await activityCache.isMachineValid("machine-1", "user-1");
        activityCache.queueSessionUpdate("session-1", now);
        activityCache.queueMachineUpdate("machine-1", now);
        acquireAccountWriteMock.mockResolvedValue(false);

        await vi.advanceTimersByTimeAsync(5000);

        expect(acquireAccountWriteMock).toHaveBeenCalledWith(dbMock, "user-1");
        expect(dbMock.session.updateMany).not.toHaveBeenCalled();
        expect(dbMock.machine.updateMany).not.toHaveBeenCalled();

        activityCache.shutdown();
    });

    it("does not cache an archived session", async () => {
        dbMock.session.findFirst.mockResolvedValue(null);

        const { activityCache } = await import("./sessionCache");

        await expect(activityCache.isSessionValid("session-archived", "user-1")).resolves.toBe(false);
        expect(activityCache.queueSessionUpdate("session-archived", Date.now())).toBe(false);
        expect(dbMock.session.updateMany).not.toHaveBeenCalled();

        activityCache.shutdown();
    });
});
