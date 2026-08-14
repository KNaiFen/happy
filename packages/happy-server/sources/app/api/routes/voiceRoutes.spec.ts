import fastify, { type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const {
    fetchMock,
    logMock,
    beginVoiceCredentialAdmissionMock,
    armVoiceCredentialAdmissionMock,
    sendVoiceCredentialForAdmissionMock,
    settleVoiceCredentialAdmissionMock,
    sendActiveAccountResponseMock,
} = vi.hoisted(() => ({
    fetchMock: vi.fn(),
    logMock: vi.fn(),
    beginVoiceCredentialAdmissionMock: vi.fn(),
    armVoiceCredentialAdmissionMock: vi.fn(),
    sendVoiceCredentialForAdmissionMock: vi.fn(),
    settleVoiceCredentialAdmissionMock: vi.fn(),
    sendActiveAccountResponseMock: vi.fn(),
}));

vi.mock("@/utils/log", () => ({ log: logMock }));
vi.mock("@/app/account/voiceCredentialAdmission", () => ({
    beginVoiceCredentialAdmission: beginVoiceCredentialAdmissionMock,
    armVoiceCredentialAdmission: armVoiceCredentialAdmissionMock,
    sendVoiceCredentialForAdmission: sendVoiceCredentialForAdmissionMock,
    settleVoiceCredentialAdmission: settleVoiceCredentialAdmissionMock,
    sendActiveAccountResponse: sendActiveAccountResponseMock,
    VoiceCredentialResponseOutcomeUnknownError: class VoiceCredentialResponseOutcomeUnknownError extends Error {},
}));

import { voiceRoutes } from "./voiceRoutes";

const ORIGINAL_ENV = { ...process.env };

function makeConversationToken(
    conversationId: string,
    expiresAt = new Date(Date.now() + 5 * 60 * 1000),
): string {
    const payload = Buffer.from(JSON.stringify({
        exp: Math.floor(expiresAt.getTime() / 1000),
        video: { room: conversationId },
    })).toString("base64url");
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
        beginVoiceCredentialAdmissionMock.mockReset();
        beginVoiceCredentialAdmissionMock.mockResolvedValue({ id: "voice-admission-1", accountId: "user-1" });
        armVoiceCredentialAdmissionMock.mockReset();
        armVoiceCredentialAdmissionMock.mockResolvedValue(true);
        sendVoiceCredentialForAdmissionMock.mockReset();
        sendVoiceCredentialForAdmissionMock.mockImplementation(async (_admission, send) => {
            send();
            return true;
        });
        settleVoiceCredentialAdmissionMock.mockReset();
        settleVoiceCredentialAdmissionMock.mockResolvedValue(undefined);
        sendActiveAccountResponseMock.mockReset();
        sendActiveAccountResponseMock.mockImplementation(async (_accountId, send) => {
            send();
            return true;
        });
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

    it("rejects a conversation request before contacting providers when deletion has started", async () => {
        beginVoiceCredentialAdmissionMock.mockResolvedValueOnce(null);
        app = await createApp("deleting-user");

        const response = await app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            payload: { agentId: "agent-1" },
        });

        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({ error: "Account deletion in progress" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not contact providers when deletion starts before provider checks", async () => {
        beginVoiceCredentialAdmissionMock.mockResolvedValueOnce(null);
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ conversations: [] }),
        });
        app = await createApp("deleting-during-check");

        const response = await app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            payload: { agentId: "agent-1" },
        });

        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({ error: "Account deletion in progress" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not return a token when deletion starts while token minting is in flight", async () => {
        armVoiceCredentialAdmissionMock.mockResolvedValueOnce(false);
        fetchMock
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ conversations: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ token: makeConversationToken("conv_race") }),
            });
        app = await createApp("deleting-during-token");

        const response = await app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            payload: { agentId: "agent-1" },
        });

        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({ error: "Account deletion in progress" });
        expect(response.body).not.toContain("conversationToken");
    });

    it("does not query voice usage for an account being deleted", async () => {
        beginVoiceCredentialAdmissionMock.mockResolvedValueOnce(null);
        app = await createApp("deleting-usage");

        const response = await app.inject({
            method: "GET",
            url: "/v1/voice/usage",
        });

        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({ error: "Account deletion in progress" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not return usage after deletion starts during provider reads", async () => {
        sendActiveAccountResponseMock.mockResolvedValueOnce(false);
        fetchMock
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ conversations: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ items: [] }),
            });
        app = await createApp("deleting-usage-race");

        const response = await app.inject({
            method: "GET",
            url: "/v1/voice/usage",
        });

        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({ error: "Account deletion in progress" });
    });

    it("arms deletion fencing with the provider JWT expiry before sending", async () => {
        const expiresAt = new Date(Date.now() + 7 * 60 * 1000);
        fetchMock
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ conversations: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ token: makeConversationToken("conv_fenced", expiresAt) }),
            });
        app = await createApp("fenced-user");

        const response = await app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            payload: { agentId: "agent-1" },
        });

        expect(response.statusCode).toBe(200);
        expect(armVoiceCredentialAdmissionMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: "voice-admission-1" }),
            new Date(Math.floor(expiresAt.getTime() / 1000) * 1000),
        );
        expect(sendVoiceCredentialForAdmissionMock).toHaveBeenCalledOnce();
        expect(settleVoiceCredentialAdmissionMock).not.toHaveBeenCalled();
    });

    it("settles an admission when provider minting fails before any token is sent", async () => {
        fetchMock
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ conversations: [] }),
            })
            .mockRejectedValueOnce(new Error("provider unavailable"));
        app = await createApp("failed-mint-user");

        const response = await app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            payload: { agentId: "agent-1" },
        });

        expect(response.statusCode).toBe(500);
        expect(settleVoiceCredentialAdmissionMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: "voice-admission-1" }),
        );
    });

    it("settles an admission when deriving the provider identity fails", async () => {
        delete process.env.HANDY_MASTER_SECRET;
        app = await createApp("missing-secret-user");

        const response = await app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            payload: { agentId: "agent-1" },
        });

        expect(response.statusCode).toBe(500);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(settleVoiceCredentialAdmissionMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: "voice-admission-1" }),
        );
    });

    it("settles a usage admission when deriving the provider identity fails", async () => {
        delete process.env.HANDY_MASTER_SECRET;
        app = await createApp("missing-secret-usage-user");

        const response = await app.inject({
            method: "GET",
            url: "/v1/voice/usage",
        });

        expect(response.statusCode).toBe(500);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(settleVoiceCredentialAdmissionMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: "voice-admission-1" }),
        );
    });

    it("rejects a provider credential with an unbounded lifetime", async () => {
        fetchMock
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ conversations: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    token: makeConversationToken(
                        "conv_unbounded",
                        new Date(Date.now() + 2 * 60 * 60 * 1000),
                    ),
                }),
            });
        app = await createApp("unbounded-token-user");

        const response = await app.inject({
            method: "POST",
            url: "/v1/voice/conversations",
            payload: { agentId: "agent-1" },
        });

        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain("conversationToken");
        expect(armVoiceCredentialAdmissionMock).not.toHaveBeenCalled();
        expect(settleVoiceCredentialAdmissionMock).toHaveBeenCalledOnce();
    });
});
