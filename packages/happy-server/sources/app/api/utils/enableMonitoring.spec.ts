import fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const { dbQueryRawMock, logMock } = vi.hoisted(() => ({
    dbQueryRawMock: vi.fn(),
    logMock: vi.fn(),
}));

vi.mock("@/storage/db", () => ({
    db: { $queryRaw: dbQueryRawMock },
}));
vi.mock("@/utils/log", () => ({ log: logMock }));
vi.mock("@/app/monitoring/metrics2", () => ({
    httpRequestsCounter: { inc: vi.fn() },
    httpRequestDurationHistogram: { observe: vi.fn() },
    getMetricsLabelsFromRequest: vi.fn(() => ({})),
}));

import { enableMonitoring } from "./enableMonitoring";

describe("enableMonitoring", () => {
    let app: Fastify | undefined;

    beforeEach(() => {
        dbQueryRawMock.mockReset();
        logMock.mockReset();
    });

    afterEach(async () => {
        await app?.close();
        app = undefined;
    });

    it("reports healthy only when Prisma decodes the synthetic BYTEA probe", async () => {
        dbQueryRawMock.mockResolvedValue([{
            byteaProbe: new Uint8Array([0, 1, 254, 255]),
        }]);
        app = fastify() as unknown as Fastify;
        enableMonitoring(app);

        const response = await app.inject({ method: "GET", url: "/health" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            status: "ok",
            service: "happy-server",
        });
        expect(dbQueryRawMock).toHaveBeenCalledOnce();
    });

    it("returns a fixed 503 without logging malformed BYTEA values", async () => {
        const sensitiveValue = "SENSITIVE_ENCRYPTED_KEY_BYTES";
        dbQueryRawMock.mockRejectedValue(new Error(
            `Conversion failed for ${sensitiveValue}`,
        ));
        app = fastify() as unknown as Fastify;
        enableMonitoring(app);

        const response = await app.inject({ method: "GET", url: "/health" });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
            status: "error",
            service: "happy-server",
            error: "Database health check failed",
        });
        expect(JSON.stringify(logMock.mock.calls)).not.toContain(sensitiveValue);
        expect(logMock).toHaveBeenCalledWith(
            { module: "health", level: "error", errorKind: "database" },
            "Database health check failed",
        );
    });

    it("rejects a successful query whose adapter returns a non-BYTEA shape", async () => {
        dbQueryRawMock.mockResolvedValue([{
            byteaProbe: { 0: 0, 1: 1, 2: 254, 3: 255 },
        }]);
        app = fastify() as unknown as Fastify;
        enableMonitoring(app);

        const response = await app.inject({ method: "GET", url: "/health" });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
            status: "error",
            error: "Database health check failed",
        });
    });
});
