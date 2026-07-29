import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { attachSyncV4Trace } from "../routes/syncV4Diagnostics";
import { enableErrorHandlers } from "./enableErrorHandlers";

const { logMock } = vi.hoisted(() => ({
    logMock: vi.fn(),
}));

vi.mock("@/utils/log", () => ({
    log: logMock,
}));

describe("enableErrorHandlers", () => {
    it("does not copy Sync v4 error messages or stacks into general logs", async () => {
        const app = fastify();
        enableErrorHandlers(app as never);
        app.get("/v4/test", {
            onRequest: [attachSyncV4Trace],
        }, async () => {
            throw new Error("prompt-reasoning-tool-output-secret");
        });
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/v4/test",
            headers: {
                "x-happy-sync-trace": "00000000000000000000000000000001",
            },
        });
        await app.close();

        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain("prompt-reasoning-tool-output-secret");
        expect(JSON.stringify(logMock.mock.calls)).not.toContain(
            "prompt-reasoning-tool-output-secret",
        );
    });

    it("returns a sanitized 500 when a Sync v4 error has a hostile status getter", async () => {
        const app = fastify();
        enableErrorHandlers(app as never);
        const secret = "prompt-reasoning-tool-output-secret";
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
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/v4/hostile",
            headers: {
                "x-happy-sync-trace": "00000000000000000000000000000001",
            },
        });
        await app.close();

        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain(secret);
        expect(JSON.stringify(logMock.mock.calls)).not.toContain(secret);
    });

    it("does not log authorization headers or query text for unknown routes", async () => {
        const app = fastify();
        enableErrorHandlers(app as never);
        await app.ready();
        const querySecret = "prompt-reasoning-tool-output-query-secret";
        const authorizationSecret = "Bearer authorization-secret";

        const response = await app.inject({
            method: "GET",
            url: `/missing?value=${querySecret}`,
            headers: {
                authorization: authorizationSecret,
            },
        });
        await app.close();

        expect(response.statusCode).toBe(404);
        const logs = JSON.stringify(logMock.mock.calls);
        expect(logs).not.toContain(querySecret);
        expect(logs).not.toContain(authorizationSecret);
        expect(logs).toContain("pathLength");
    });
});
