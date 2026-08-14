import fastify, { type FastifyBaseLogger } from "fastify";
import { log, logger } from "@/utils/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { authRoutes } from "./routes/authRoutes";
import { pushRoutes } from "./routes/pushRoutes";
import { sessionRoutes } from "./routes/sessionRoutes";
import { connectRoutes } from "./routes/connectRoutes";
import { accountRoutes } from "./routes/accountRoutes";
import { startSocket } from "./socket";
import { machinesRoutes } from "./routes/machinesRoutes";
import { devRoutes } from "./routes/devRoutes";
import { versionRoutes } from "./routes/versionRoutes";
import { voiceRoutes } from "./routes/voiceRoutes";
import { artifactsRoutes } from "./routes/artifactsRoutes";
import { accessKeysRoutes } from "./routes/accessKeysRoutes";
import { enableMonitoring } from "./utils/enableMonitoring";
import { enableErrorHandlers } from "./utils/enableErrorHandlers";
import { enableAuthentication } from "./utils/enableAuthentication";
import { userRoutes } from "./routes/userRoutes";
import { feedRoutes } from "./routes/feedRoutes";
import { kvRoutes } from "./routes/kvRoutes";
import { v4CapabilitiesRoutes, v4SessionRoutes } from "./routes/v4SessionRoutes";
import { attachmentRoutes } from "./routes/attachmentRoutes";
import { getFileStream } from "@/storage/files";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { acquireAccountRead } from "@/app/account/accountWriteGate";
import * as path from "path";
import * as fs from "fs";
import { SYNC_V4_TRACE_HEADER } from "./routes/syncV4Diagnostics";

export interface StartApiOptions {
    port?: number;
    host?: string;
    staticDir?: string;
    injectHtmlConfig?: Record<string, unknown>;
}

export function createFastifyServer(loggerInstance: FastifyBaseLogger = logger) {
    return fastify({
        loggerInstance,
        disableRequestLogging: true,
        bodyLimit: 1024 * 1024 * 100, // 100MB
    });
}

export async function startApi(opts: StartApiOptions = {}) {

    // Configure
    log('Starting API...');

    // Start API
    const app = createFastifyServer();
    app.register(import('@fastify/cors'), {
        origin: '*',
        allowedHeaders: [
            'Authorization',
            'Content-Type',
            'X-Happy-Client',
            'X-Happy-Machine-Id',
            SYNC_V4_TRACE_HEADER,
        ],
        exposedHeaders: [SYNC_V4_TRACE_HEADER],
        methods: ['GET', 'POST', 'PUT', 'DELETE']
    });

    // Required for local-mode attachment uploads (PUT /v1/sessions/:id/attachments/:file).
    // Fastify v5 rejects unknown media types with 415 before reaching the handler.
    app.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer' },
        (_req, body, done) => done(null, body),
    );

    // Root handler — when not serving a static webapp, return a banner.
    // When serving a static webapp, @fastify/static handles `/` via its index.
    if (!opts.staticDir) {
        app.get('/', function (request, reply) {
            reply.send('Welcome to Happy Server!');
        });
    }

    // Create typed provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Enable features
    enableMonitoring(typed);
    enableErrorHandlers(typed, { skipNotFoundHandler: !!opts.staticDir });
    enableAuthentication(typed);

    // Profile images stay behind the API in both storage modes. A public S3 URL
    // cannot be revoked during account deletion; this route checks the owner
    // record every time before it streams the object.
    app.get('/files/*', async (request, reply) => {
        const filePath = (request.params as any)['*'];
        const accountId = accountIdFromPublicFilePath(filePath);
        if (!accountId) {
            return reply.code(404).send('Not found');
        }
        try {
            const stream = await inTx(async (tx) => {
                if (!await acquireAccountRead(tx, accountId)) return null;
                const account = await tx.account.findUnique({
                    where: { id: accountId },
                    select: { deletionRequestedAt: true },
                });
                if (!account || account.deletionRequestedAt !== null) return null;
                return getFileStream(filePath);
            });
            if (!stream) return reply.code(404).send('Not found');
            return reply.send(stream);
        } catch {
            return reply.code(404).send('Not found');
        }
    });

    // Routes
    authRoutes(typed);
    pushRoutes(typed);
    sessionRoutes(typed);
    accountRoutes(typed);
    connectRoutes(typed);
    machinesRoutes(typed);
    artifactsRoutes(typed);
    accessKeysRoutes(typed);
    devRoutes(typed);
    versionRoutes(typed);
    voiceRoutes(typed);
    userRoutes(typed);
    feedRoutes(typed);
    kvRoutes(typed);
    v4CapabilitiesRoutes(typed);
    v4SessionRoutes(typed);
    attachmentRoutes(typed);

    // Static webapp (self-host mode)
    if (opts.staticDir) {
        const fastifyStatic = (await import('@fastify/static')).default;
        const injectScript = opts.injectHtmlConfig
            ? `<script>window.__HAPPY_CONFIG__ = ${JSON.stringify(opts.injectHtmlConfig)};</script>`
            : null;
        app.register(fastifyStatic, {
            root: opts.staticDir,
            prefix: '/',
            decorateReply: false,
            // SPA fallback — if file not found, serve index.html
            wildcard: false,
        });
        if (injectScript) {
            app.addHook('onSend', async (request, reply, payload) => {
                const url = request.raw.url || '';
                const isIndex = url === '/' || url === '/index.html' || url.startsWith('/?');
                if (!isIndex) return payload;
                const contentType = reply.getHeader('content-type');
                if (typeof contentType !== 'string' || !contentType.includes('text/html')) return payload;
                let html: string;
                if (typeof payload === 'string') {
                    html = payload;
                } else if (Buffer.isBuffer(payload)) {
                    html = payload.toString('utf8');
                } else if (payload && typeof (payload as any).pipe === 'function') {
                    // stream — read it
                    const chunks: Buffer[] = [];
                    for await (const chunk of payload as any) {
                        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
                    }
                    html = Buffer.concat(chunks).toString('utf8');
                } else {
                    return payload;
                }
                const injected = html.replace(/<head[^>]*>/i, (m) => `${m}\n${injectScript}`);
                reply.header('content-length', Buffer.byteLength(injected));
                return injected;
            });
        }
        // SPA fallback: serve index.html for any unmatched GET that looks like a route.
        app.setNotFoundHandler(async (request, reply) => {
            const url = request.raw.url || '';
            // Don't fall through for API/socket/files paths
            if (request.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
            if (url.startsWith('/v1') || url.startsWith('/v3') || url.startsWith('/v4') || url.startsWith('/socket') ||
                url.startsWith('/files/') || url.startsWith('/metrics') || url.startsWith('/health')) {
                return reply.code(404).send({ error: 'Not found' });
            }
            const indexPath = path.join(opts.staticDir!, 'index.html');
            if (!fs.existsSync(indexPath)) {
                return reply.code(404).send({ error: 'Not found' });
            }
            const html = fs.readFileSync(indexPath, 'utf8');
            const injected = injectScript ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${injectScript}`) : html;
            reply.type('text/html').send(injected);
        });
    }

    // Start HTTP
    const port = opts.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3005);
    const host = opts.host ?? '0.0.0.0';
    await app.listen({ port, host });
    onShutdown('api', async () => {
        await app.close();
    });

    // Start Socket
    startSocket(typed);

    // End
    log(`API ready on http://${host}:${port}`);
    return { port, host };
}

function accountIdFromPublicFilePath(filePath: unknown): string | null {
    if (typeof filePath !== 'string' || !filePath) return null;
    const normalized = path.posix.normalize(filePath);
    if (normalized !== filePath || normalized.startsWith('/') || normalized.includes('..')) {
        return null;
    }
    const segments = normalized.split('/');
    if (segments.length < 4 || segments[0] !== 'public' || segments[1] !== 'users' || !segments[2]) {
        return null;
    }
    return segments[2];
}
