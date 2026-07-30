import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
    dbMock,
    counterIncMock,
    resetMocks,
} = vi.hoisted(() => {
    const dbMock = {
        session: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        machine: {
            findFirst: vi.fn(),
            updateMany: vi.fn(),
        },
    };
    const counterIncMock = vi.fn();
    const resetMocks = () => {
        dbMock.session.findUnique.mockReset();
        dbMock.session.update.mockReset();
        dbMock.machine.findFirst.mockReset();
        dbMock.machine.updateMany.mockReset();
        counterIncMock.mockReset();
    };
    return { dbMock, counterIncMock, resetMocks };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
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
                accountId: "user-1",
                id: "machine-deleted",
                deletedAt: null,
            },
        });
        expect(activityCache.queueMachineUpdate("machine-deleted", Date.now())).toBe(false);
        expect(dbMock.machine.updateMany).not.toHaveBeenCalled();

        activityCache.shutdown();
    });
});
