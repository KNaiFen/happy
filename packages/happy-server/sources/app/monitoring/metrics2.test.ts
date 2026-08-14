import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => {
    const dbMock = {
        account: { count: vi.fn() },
        session: { count: vi.fn() },
        sessionMessage: { count: vi.fn() },
        machine: { count: vi.fn() },
        $queryRaw: vi.fn()
    };

    return { dbMock };
});

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

import {
    getMetricsLabelsFromRequest,
    getSyncV4MetricsLabelsFromRequest,
    updateDatabaseMetrics,
} from "./metrics2";

describe("metric client labels", () => {
    it("uses fixed client buckets instead of client-controlled versions", () => {
        const request = {
            headers: {
                "x-happy-client": "cli-coding-session/1.4.5",
            },
        };

        expect(getMetricsLabelsFromRequest(request)).toEqual({
            client: "cli-coding-session",
            client_type: "cli-coding-session",
        });
        expect(getSyncV4MetricsLabelsFromRequest(request)).toEqual({
            client_type: "cli-coding-session",
        });
    });

    it("buckets hostile and non-string labels as unknown without retaining plaintext", () => {
        const secret = "prompt-reasoning-tool-output-client-secret";
        const hostile = getMetricsLabelsFromRequest({
            headers: { "x-happy-client": `${secret}/999.999.999` },
        });
        const arrayValue = getMetricsLabelsFromRequest({
            headers: { "x-happy-client": [`web/1.11.10`, secret] },
        });

        expect(hostile).toEqual({ client: "unknown", client_type: "unknown" });
        expect(arrayValue).toEqual({ client: "unknown", client_type: "unknown" });
        expect(JSON.stringify([hostile, arrayValue])).not.toContain(secret);
    });
});

describe("updateDatabaseMetrics", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.account.count.mockResolvedValue(10);
        dbMock.session.count.mockResolvedValue(20);
        dbMock.sessionMessage.count.mockResolvedValue(30);
        dbMock.machine.count.mockResolvedValue(40);
        dbMock.$queryRaw.mockResolvedValue([{ estimated_count: 123n }]);
    });

    it("uses estimated counts instead of exact table counts", async () => {
        await updateDatabaseMetrics();

        expect(dbMock.account.count).not.toHaveBeenCalled();
        expect(dbMock.session.count).not.toHaveBeenCalled();
        expect(dbMock.sessionMessage.count).not.toHaveBeenCalled();
        expect(dbMock.machine.count).not.toHaveBeenCalled();
        expect(dbMock.$queryRaw).toHaveBeenCalledTimes(4);

        const queriedTables = dbMock.$queryRaw.mock.calls.map((call) => call[1]);
        expect(queriedTables).toEqual(['"Account"', '"Session"', '"SessionMessage"', '"Machine"']);
    });
});
