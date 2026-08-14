import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, emitEphemeralMock } = vi.hoisted(() => ({
    dbMock: {
        session: {
            findMany: vi.fn(),
            updateManyAndReturn: vi.fn(),
        },
    },
    emitEphemeralMock: vi.fn(),
}));

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    return {
        ...actual,
        eventRouter: { emitEphemeral: emitEphemeralMock },
    };
});

import { expireTimedOutSessions } from "./timeout";

describe("expireTimedOutSessions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("uses the scanned deadline as a compare-and-set condition", async () => {
        const now = Date.parse("2026-01-01T00:10:00.000Z");
        const lastActiveAt = new Date("2026-01-01T00:00:00.000Z");
        dbMock.session.findMany.mockResolvedValue([{
            id: "session-1",
            accountId: "user-1",
            lastActiveAt,
        }]);
        dbMock.session.updateManyAndReturn.mockResolvedValue([]);

        await expireTimedOutSessions(now);

        expect(dbMock.session.findMany).toHaveBeenCalledWith({
            where: {
                active: true,
                archivedAt: null,
                lastActiveAt: { lte: new Date(now - 10 * 60 * 1000) },
            },
            select: { id: true, accountId: true, lastActiveAt: true },
        });
        expect(dbMock.session.updateManyAndReturn).toHaveBeenCalledWith({
            where: {
                account: { is: { deletionRequestedAt: null } },
                id: "session-1",
                active: true,
                archivedAt: null,
                lastActiveAt,
            },
            data: { active: false, presenceLeaseId: null },
        });
        expect(emitEphemeralMock).not.toHaveBeenCalled();
    });

    it("emits one inactive event only after the timeout transition succeeds", async () => {
        const lastActiveAt = new Date("2026-01-01T00:00:00.000Z");
        dbMock.session.findMany.mockResolvedValue([{
            id: "session-1",
            accountId: "user-1",
            lastActiveAt,
        }]);
        dbMock.session.updateManyAndReturn.mockResolvedValue([{ lastActiveAt }]);

        await expireTimedOutSessions(Date.parse("2026-01-01T00:10:00.000Z"));

        expect(emitEphemeralMock).toHaveBeenCalledWith(expect.objectContaining({
            userId: "user-1",
            payload: expect.objectContaining({
                type: "activity",
                id: "session-1",
                active: false,
                activeAt: lastActiveAt.getTime(),
                archivedAt: null,
            }),
        }));
    });
});
