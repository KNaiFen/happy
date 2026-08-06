import fastify, { type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const { fetchMock, logMock } = vi.hoisted(() => ({
    fetchMock: vi.fn(),
    logMock: vi.fn(),
}));

vi.mock("@/utils/log", () => ({ log: logMock }));

import { voiceRoutes } from "./voiceRoutes";

const ORIGINAL_ENV = { ...process.env };

function makeConversationToken(conversationId: string): string {
    const payload = Buffer.from(JSON.stringify({ video: { room: conversationId } })).toString("base64url");
    return `header.${payload}.signature`;
}

async function createApp(userId: string): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typedApp = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typedApp.decorate("authenticate", async (request: FastifyRequest) => {
        request.userId = userId;
    });
    voiceRoutes(typedApp);
    await typedApp.ready();
    return typedApp;
}

describe("voiceRoutes sensitive logging", () => {
    let app: Fastify | undefined;

    beforeEach(() => {
        fetchMock.mockReset();
        logMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
        process.env.ELEVENLABS_API_KEY = "provider-api-key";
        process.env.REVENUECAT_API_KEY = "subscription-api-key";
        process.env.HANDY_MASTER_SECRET = "master-secret";
    });

    afterEach(async () => {
        await app?.close();
        app = undefined;
        vi.unstubAllGlobals();
        process.env = { ...ORIGINAL_ENV };
    });

    it("keeps user, agent, provider and conversation identifiers out of success logs", async () => {
        const secret = "SensitiveVoiceIdentifier";
        const conversationId = `conv_${secret}`;
        fetchMock
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ conversations: [{ call_duration_secs: 17 }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ token: makeConversationToken(conversationId) }),
            });
        app = await createApp(`user-${secret}`);

        const response = await app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            payload: { agentId: `agent-${secret}` },
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toContain(conversationId);
        const logs = JSON.stringify(logMock.mock.calls);
        expect(logs).not.toContain(secret);
        expect(logs).toContain("credentials.issued");
        expect(logs).toContain("under-free");
    });

    it("does not serialize provider errors on failure paths", async () => {
        const secret = "SensitiveProviderError";
        fetchMock
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ conversations: [] }),
            })
            .mockRejectedValueOnce(new Error(secret));
        app = await createApp(`user-${secret}`);

        const response = await app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            payload: { agentId: `agent-${secret}` },
        });

        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain(secret);
        const logs = JSON.stringify(logMock.mock.calls);
        expect(logs).not.toContain(secret);
        expect(logs).toContain("credentials.request.failed");
    });

    it("fails closed when the usage request rejects", async () => {
        const secret = "SensitiveUsageNetworkError";
        fetchMock.mockRejectedValueOnce(new Error(secret));
        app = await createApp(`user-${secret}`);

        const response = await app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            payload: { agentId: `agent-${secret}` },
        });

        expect(response.statusCode).toBe(502);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const logs = JSON.stringify(logMock.mock.calls);
        expect(response.body).not.toContain(secret);
        expect(logs).not.toContain(secret);
        expect(logs).toContain("provider.usage.failed");
        expect(logs).not.toContain("credentials.issued");
        expect(logs).not.toContain("under-free");
    });

    it("fails closed when the usage provider returns a non-success response", async () => {
        const secret = "SensitiveUsageHttpError";
        fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
        app = await createApp(`user-${secret}`);

        const response = await app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            payload: { agentId: `agent-${secret}` },
        });

        expect(response.statusCode).toBe(502);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const logs = JSON.stringify(logMock.mock.calls);
        expect(response.body).not.toContain(secret);
        expect(logs).not.toContain(secret);
        expect(logs).toContain("provider.usage.failed");
        expect(logs).toContain("4xx");
        expect(logs).not.toContain("credentials.issued");
        expect(logs).not.toContain("under-free");
    });
});
