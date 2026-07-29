import fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachSyncV4Trace } from "../routes/syncV4Diagnostics";
import { type Fastify } from "../types";

const { logMock } = vi.hoisted(() => ({ logMock: vi.fn() }));

vi.mock("@/utils/log", () => ({ log: logMock }));

import { enableErrorHandlers } from "./enableErrorHandlers";

describe("enableErrorHandlers", () => {
    let app: Fastify | undefined;

    beforeEach(() => {
        logMock.mockReset();
    });

    afterEach(async () => {
        await app?.close();
        app = undefined;
    });

    it("does not copy Sync v4 error messages or stacks into general logs", async () => {
        const secret = "prompt-reasoning-tool-output-secret";
        app = fastify() as unknown as Fastify;
        enableErrorHandlers(app);
        app.get("/v4/test", {
            onRequest: [attachSyncV4Trace],
        }, async () => {
            throw new Error(secret);
        });

        const response = await app.inject({
            method: "GET",
            url: "/v4/test",
            headers: {
                "x-happy-sync-trace": "00000000000000000000000000000001",
            },
        });

        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain(secret);
        expect(JSON.stringify(logMock.mock.calls)).not.toContain(secret);
    });

    it("returns a sanitized 500 when a Sync v4 error has a hostile status getter", async () => {
        const secret = "prompt-reasoning-tool-output-secret";
        app = fastify() as unknown as Fastify;
        enableErrorHandlers(app);
        app.get("/v4/hostile", {
            onRequest: [attachSyncV4Trace],
        }, async () => {
            const error = new Error(secret);
            Object.defineProperty(error, "statusCode", {
                get: () => {
                    throw new Error(secret);
                },
            });
            throw error;
        });

        const response = await app.inject({
            method: "GET",
            url: "/v4/hostile",
            headers: {
                "x-happy-sync-trace": "00000000000000000000000000000001",
            },
        });

        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain(secret);
        expect(JSON.stringify(logMock.mock.calls)).not.toContain(secret);
    });

    it("does not log authorization headers or query text for unknown routes", async () => {
        const querySecret = "prompt-reasoning-tool-output-query-secret";
        const authorizationSecret = "Bearer authorization-secret";
        app = fastify() as unknown as Fastify;
        enableErrorHandlers(app);

        const response = await app.inject({
            method: "GET",
            url: `/missing?value=${querySecret}`,
            headers: {
                authorization: authorizationSecret,
            },
        });

        expect(response.statusCode).toBe(404);
        const logs = JSON.stringify(logMock.mock.calls);
        expect(logs).not.toContain(querySecret);
        expect(logs).not.toContain(authorizationSecret);
        expect(logs).toContain("pathLength");
    });

    it("logs one payload-free terminal record for a Prisma server error", async () => {
        const sensitiveValue = "SENSITIVE_ENCRYPTED_KEY_BYTES";
        app = fastify() as unknown as Fastify;
        enableErrorHandlers(app);
        app.get("/boom/:id", async () => {
            const error = new Error(`P2023 dataEncryptionKey ${sensitiveValue}`) as Error & {
                code: string;
                statusCode: number;
            };
            error.code = "P2023";
            error.statusCode = 500;
            throw error;
        });

        const response = await app.inject({
            method: "GET",
            url: `/boom/${sensitiveValue}?token=${sensitiveValue}`,
            headers: {
                "user-agent": sensitiveValue,
                "x-forwarded-for": sensitiveValue,
            },
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
            error: "Internal Server Error",
            message: "An unexpected error occurred",
            statusCode: 500,
        });
        expect(logMock).toHaveBeenCalledTimes(1);
        expect(logMock).toHaveBeenCalledWith({
            module: "fastify-error",
            level: "error",
            method: "GET",
            route: "/boom/:id",
            statusCode: 500,
            errorKind: "prisma",
            errorCode: "P2023",
        }, "Request failed");
        expect(JSON.stringify(logMock.mock.calls)).not.toContain(sensitiveValue);
    });
});
