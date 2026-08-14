import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const {
    state,
    dbMock,
    filesMock,
    beginUploadOperation,
    settleUploadOperation,
    acquireAccountRead,
    resetState,
    seedSession
} = vi.hoisted(() => {
    const state = {
        sessions: [] as Array<{ id: string; accountId: string }>,
        uploads: new Map<string, Buffer>(),
    };

    const seedSession = (id: string, accountId: string) => {
        state.sessions.push({ id, accountId });
    };

    const sessionFindFirst = vi.fn(async (args: any) => {
        return state.sessions.find((s) =>
            s.id === args?.where?.id && s.accountId === args?.where?.accountId,
        ) ?? null;
    });

    const dbMock = { session: { findFirst: sessionFindFirst } };

    const filesMock = {
        putFile: vi.fn(async (filePath: string, data: Buffer) => {
            state.uploads.set(filePath, data);
        }),
        getFileStream: vi.fn(async (filePath: string) => {
            const content = state.uploads.get(filePath);
            if (!content) throw new Error("not found");
            return content;
        }),
    };

    const resetState = () => {
        state.sessions = [];
        state.uploads = new Map();
        filesMock.putFile.mockClear();
        filesMock.getFileStream.mockClear();
    };

    const beginUploadOperation = vi.fn(async () => 'upload-operation-1');
    const settleUploadOperation = vi.fn(async () => {});
    const acquireAccountRead = vi.fn(async () => true);

    return {
        state,
        dbMock,
        filesMock,
        beginUploadOperation,
        settleUploadOperation,
        acquireAccountRead,
        resetState,
        seedSession,
    };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock('@/storage/inTx', () => ({
    inTx: async (callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock),
}));
vi.mock('@/app/account/accountWriteGate', () => ({ acquireAccountRead }));
vi.mock("@/storage/files", () => filesMock);
vi.mock('@/app/account/accountDeletion', () => ({
    beginAccountDeletionUpload: beginUploadOperation,
    settleAccountDeletionUpload: settleUploadOperation,
}));

import { attachmentRoutes } from "./attachmentRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    // Octet-stream parser is normally registered in api.ts startApi() — mirror
    // that here so PUT bodies arrive as Buffer in the handler.
    app.addContentTypeParser(
        "application/octet-stream",
        { parseAs: "buffer" },
        (_req, body, done) => done(null, body),
    );

    attachmentRoutes(typed);
    await typed.ready();
    return typed;
}

describe("attachmentRoutes — request-upload", () => {
    let app: Fastify;
    beforeEach(() => {
        resetState();
        beginUploadOperation.mockReset();
        beginUploadOperation.mockResolvedValue('upload-operation-1');
        settleUploadOperation.mockReset();
        settleUploadOperation.mockResolvedValue(undefined);
        acquireAccountRead.mockReset();
        acquireAccountRead.mockResolvedValue(true);
    });
    afterEach(async () => { if (app) await app.close(); });

    it("returns an authenticated Server PUT URL for the session owner", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "screenshot.exe", size: 1024 },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.method).toBe("PUT");
        expect(body.ref).toMatch(/^sessions\/s1\/attachments\/[A-Fa-f0-9-]+\.enc$/);
        expect(body.uploadUrl).toContain("/v1/sessions/s1/attachments/");
        expect(body.uploadUrl).toMatch(/\.enc$/);
        expect(body.requiresAuth).toBe(true);
    });

    it("does not issue an S3 capability when object storage is configured", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "img.jpg", size: 1024 },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.method).toBe("PUT");
        expect(body.uploadUrl).toContain("/v1/sessions/s1/attachments/");
        expect(body.formFields).toBeUndefined();
        expect(body.requiresAuth).toBe(true);
    });

    it("returns 404 when the requesting user is not the session owner", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u2" },
            payload: { filename: "x.png", size: 100 },
        });
        expect(res.statusCode).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            payload: { filename: "x.png", size: 100 },
        });
        expect(res.statusCode).toBe(401);
    });

    it("returns 413 when the declared size exceeds the 10MB limit", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "huge.bin", size: 10 * 1024 * 1024 + 1 },
        });
        // Zod schema rejects size > 10MB at validation stage with 400.
        expect([400, 413]).toContain(res.statusCode);
    });
});

describe("attachmentRoutes — PUT (authenticated upload)", () => {
    let app: Fastify;
    beforeEach(() => {
        resetState();
        beginUploadOperation.mockReset();
        beginUploadOperation.mockResolvedValue('upload-operation-1');
        settleUploadOperation.mockReset();
        settleUploadOperation.mockResolvedValue(undefined);
    });
    afterEach(async () => { if (app) await app.close(); });

    it("accepts the encrypted blob from the session owner and stores it under the session prefix", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const blob = Buffer.from("encrypted-bytes");
        const res = await app.inject({
            method: "PUT",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: blob,
        });

        expect(res.statusCode).toBe(200);
        expect(state.uploads.get("sessions/s1/attachments/abc.enc")).toEqual(blob);
        expect(beginUploadOperation).toHaveBeenCalledWith(
            'u1',
            'sessions/s1/attachments/abc.enc',
        );
        expect(settleUploadOperation).toHaveBeenCalledWith('upload-operation-1');
    });

    it("rejects path traversal in attachment file segment", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const evil = await app.inject({
            method: "PUT",
            url: "/v1/sessions/s1/attachments/..evil",
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: Buffer.from("x"),
        });
        expect(evil.statusCode).toBe(404);
    });

    it("rejects upload from a non-owner of the session", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u2", "content-type": "application/octet-stream" },
            payload: Buffer.from("x"),
        });
        expect(res.statusCode).toBe(404);
    });

    it("proxies an authenticated PUT into the configured object storage", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: Buffer.from("x"),
        });
        expect(res.statusCode).toBe(200);
        expect(state.uploads.get("sessions/s1/attachments/abc.enc")).toEqual(Buffer.from("x"));
    });

    it('keeps the upload operation pending when object storage reports an unknown write result', async () => {
        seedSession('s1', 'u1');
        filesMock.putFile.mockRejectedValueOnce(new Error('connection reset'));
        app = await createApp();

        const res = await app.inject({
            method: 'PUT',
            url: '/v1/sessions/s1/attachments/abc.enc',
            headers: { 'x-user-id': 'u1', 'content-type': 'application/octet-stream' },
            payload: Buffer.from('x'),
        });

        expect(res.statusCode).toBe(500);
        expect(settleUploadOperation).not.toHaveBeenCalled();
    });

    it('does not start an object write after account deletion takes the upload gate', async () => {
        seedSession('s1', 'u1');
        beginUploadOperation.mockResolvedValueOnce(null as never);
        app = await createApp();

        const res = await app.inject({
            method: 'PUT',
            url: '/v1/sessions/s1/attachments/abc.enc',
            headers: { 'x-user-id': 'u1', 'content-type': 'application/octet-stream' },
            payload: Buffer.from('x'),
        });

        expect(res.statusCode).toBe(409);
        expect(filesMock.putFile).not.toHaveBeenCalled();
        expect(settleUploadOperation).not.toHaveBeenCalled();
    });

    it('rejects an actual PUT body larger than 10MB before storage', async () => {
        seedSession('s1', 'large-body-user');
        app = await createApp();

        const res = await app.inject({
            method: 'PUT',
            url: '/v1/sessions/s1/attachments/large.enc',
            headers: {
                'x-user-id': 'large-body-user',
                'content-type': 'application/octet-stream',
            },
            payload: Buffer.alloc(10 * 1024 * 1024 + 1),
        });

        expect(res.statusCode).toBe(413);
        expect(filesMock.putFile).not.toHaveBeenCalled();
        expect(beginUploadOperation).not.toHaveBeenCalled();
    });

    it('rate-limits the 61st actual PUT within one minute', async () => {
        seedSession('s1', 'rate-user');
        app = await createApp();

        for (let attempt = 0; attempt < 60; attempt++) {
            const res = await app.inject({
                method: 'PUT',
                url: `/v1/sessions/s1/attachments/${attempt}.enc`,
                headers: {
                    'x-user-id': 'rate-user',
                    'content-type': 'application/octet-stream',
                },
                payload: Buffer.from('x'),
            });
            expect(res.statusCode).toBe(200);
        }

        const limited = await app.inject({
            method: 'PUT',
            url: '/v1/sessions/s1/attachments/61.enc',
            headers: {
                'x-user-id': 'rate-user',
                'content-type': 'application/octet-stream',
            },
            payload: Buffer.from('x'),
        });

        expect(limited.statusCode).toBe(429);
        expect(filesMock.putFile).toHaveBeenCalledTimes(60);
    });
});

describe("attachmentRoutes — POST request-download", () => {
    let app: Fastify;
    beforeEach(() => {
        resetState();
        acquireAccountRead.mockReset();
        acquireAccountRead.mockResolvedValue(true);
    });
    afterEach(async () => { if (app) await app.close(); });

    it("returns an authenticated Server download URL for the session owner", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: "sessions/s1/attachments/abc.enc" },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.downloadUrl).toContain("/v1/sessions/s1/attachments/abc.enc");
        expect(body.requiresAuth).toBe(true);
    });

    it("does not return a presigned S3 GET URL", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: "sessions/s1/attachments/abc.enc" },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().downloadUrl).toContain("/v1/sessions/s1/attachments/abc.enc");
        expect(res.json().requiresAuth).toBe(true);
    });

    it("rejects a ref that does not belong to the requested session (cross-session attack)", async () => {
        seedSession("s1", "u1");
        seedSession("s2", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: "sessions/s2/attachments/abc.enc" },
        });

        expect(res.statusCode).toBe(400);
    });

    it("rejects path traversal inside the ref", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: "sessions/s1/attachments/../escape" },
        });

        expect(res.statusCode).toBe(400);
    });

    it("returns 404 for a non-owner of the session", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u2" },
            payload: { ref: "sessions/s1/attachments/abc.enc" },
        });

        expect(res.statusCode).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            payload: { ref: "sessions/s1/attachments/abc.enc" },
        });

        expect(res.statusCode).toBe(401);
    });
});

describe("attachmentRoutes — GET (authenticated download)", () => {
    let app: Fastify;
    beforeEach(() => {
        resetState();
        acquireAccountRead.mockReset();
        acquireAccountRead.mockResolvedValue(true);
    });
    afterEach(async () => { if (app) await app.close(); });

    it("serves the encrypted blob to the session owner", async () => {
        seedSession("s1", "u1");
        state.uploads.set("sessions/s1/attachments/abc.enc", Buffer.from("payload"));
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u1" },
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("application/octet-stream");
        expect(res.rawPayload).toEqual(Buffer.from("payload"));
    });

    it("streams the object-storage blob rather than redirecting to a capability URL", async () => {
        seedSession("s1", "u1");
        state.uploads.set("sessions/s1/attachments/abc.enc", Buffer.from("payload"));
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u1" },
        });

        expect(res.statusCode).toBe(200);
        expect(res.rawPayload).toEqual(Buffer.from("payload"));
    });

    it("returns 404 for non-owner", async () => {
        seedSession("s1", "u1");
        state.uploads.set("sessions/s1/attachments/abc.enc", Buffer.from("payload"));
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u2" },
        });
        expect(res.statusCode).toBe(404);
    });

    it("rejects path traversal", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/..evil",
            headers: { "x-user-id": "u1" },
        });
        expect(res.statusCode).toBe(404);
    });

    it("returns 404 when the attachment file is missing", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/missing.enc",
            headers: { "x-user-id": "u1" },
        });
        expect(res.statusCode).toBe(404);
    });

    it("does not open a new object stream after account deletion is admitted", async () => {
        seedSession("s1", "u1");
        state.uploads.set("sessions/s1/attachments/abc.enc", Buffer.from("payload"));
        acquireAccountRead.mockResolvedValueOnce(false);
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u1" },
        });

        expect(res.statusCode).toBe(404);
        expect(filesMock.getFileStream).not.toHaveBeenCalled();
    });
});
