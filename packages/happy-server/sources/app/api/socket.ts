import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Redis } from "ioredis";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { getMetricsLabelsFromSocket, redisStreamLagMsGauge, websocketConnectionsGauge, websocketEventsCounter } from "../monitoring/metrics2";
import { usageHandler } from "./socket/usageHandler";
import { rpcHandler } from "./socket/rpcHandler";
import { pingHandler } from "./socket/pingHandler";
import { sessionUpdateHandler } from "./socket/sessionUpdateHandler";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { diagnosticHash } from "@/utils/diagnosticHash";
import { authorizeSocketScope } from "./socket/authorizeSocketScope";

export function startSocket(app: Fastify) {
    const io = new Server(app.server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST", "OPTIONS"],
            credentials: true,
            allowedHeaders: ["*"]
        },
        transports: ['websocket', 'polling'],
        pingTimeout: 45000,
        pingInterval: 15000,
        path: '/v1/updates',
        allowUpgrades: true,
        upgradeTimeout: 10000,
        connectTimeout: 20000,
        serveClient: false, // Don't serve the client files
        // Brief-disconnect event replay. Currently OFF to preserve parity with
        // pre-multi-process prod behavior — clients fall through to the full
        // REST re-fetch path on every reconnect (apiSocket.ts onReconnected
        // listener). Enabling this lets socket.io replay missed events from
        // the streams adapter (which implements restoreSession via the Redis
        // stream) so the client can skip the heavy refetch when
        // socket.recovered === true. Verified working cross-replica via
        // deploy/integration-tests/missed-events.mjs (event #2 fired during a
        // forced engine.close() arrived after auto-reconnect, recovered=true).
        // Ship parity first; turn this on as a follow-up.
        // connectionStateRecovery: {
        //     maxDisconnectionDuration: 2 * 60 * 1000,
        // },
    });

    // Multi-process support: attach Redis streams adapter when REDIS_URL is set
    if (process.env.REDIS_URL) {
        const streamClient = new Redis(process.env.REDIS_URL);
        io.adapter(createAdapter(streamClient, { maxLen: 200000, readCount: 2000 }));
        log({ module: 'websocket' }, 'Redis streams adapter enabled for multi-process support');

        // Track stream reader lag: wrap onRawMessage to capture last-read offset,
        // then periodically compare against stream HEAD.
        let lastReadOffset = "0-0";
        const adapter = io.of("/").adapter as any;
        const origOnRawMessage = adapter.onRawMessage.bind(adapter);
        adapter.onRawMessage = (msg: any, offset: string) => {
            lastReadOffset = offset;
            return origOnRawMessage(msg, offset);
        };
        setInterval(async () => {
            try {
                const info = await streamClient.xinfo("STREAM", "socket.io") as any[];
                const headId = String(info[info.indexOf("last-generated-id") + 1]);
                const headMs = parseInt(headId.split("-")[0]);
                const readMs = parseInt(lastReadOffset.split("-")[0]);
                redisStreamLagMsGauge.set(headMs - readMs);
            } catch { /* stream may not exist yet */ }
        }, 5000);
    }

    // Initialize event router with Socket.IO server instance
    eventRouter.init(io);

    // Auth runs in middleware so it completes BEFORE the client's `connect`
    // event fires. Without this, the async verifyToken in the connection
    // callback creates a window where client events (rpc-register, rpc-call)
    // arrive before handlers are attached — and get silently dropped.
    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token as string;
        const clientType = socket.handshake.auth.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const sessionId = socket.handshake.auth.sessionId as string | undefined;
        const machineId = socket.handshake.auth.machineId as string | undefined;

        if (!token) {
            log({ module: 'websocket' }, `No token provided`);
            next(new Error('Missing authentication token'));
            return;
        }

        if (clientType === 'session-scoped' && !sessionId) {
            log({ module: 'websocket' }, `Session-scoped client missing sessionId`);
            next(new Error('Session ID required for session-scoped clients'));
            return;
        }

        if (clientType === 'machine-scoped' && !machineId) {
            log({ module: 'websocket' }, `Machine-scoped client missing machineId`);
            next(new Error('Machine ID required for machine-scoped clients'));
            return;
        }

        try {
            const verified = await auth.verifyToken(token);
            if (!verified) {
                log({ module: 'websocket' }, `Invalid token provided`);
                next(new Error('Invalid authentication token'));
                return;
            }

            const authorized = await authorizeSocketScope({
                userId: verified.userId,
                credentialId: verified.credentialId,
                clientType,
                sessionId,
                machineId,
            });
            if (!authorized) {
                log({ module: 'websocket' }, 'Socket scope authorization failed');
                next(new Error('Socket scope is not authorized'));
                return;
            }

            socket.data.userId = verified.userId;
            socket.data.credentialId = verified.credentialId;
            socket.data.authToken = token;
            socket.data.clientType = clientType;
            socket.data.sessionId = sessionId;
            socket.data.machineId = machineId;
            socket.data.happyClient = socket.handshake.auth.happyClient as string
                || socket.handshake.headers['x-happy-client'] as string
                || undefined;
            next();
        } catch {
            log({ module: 'websocket', level: 'error' }, 'Socket authentication failed');
            next(new Error('Socket authentication failed'));
        }
    });

    io.on("connection", (socket) => {
        const userId = socket.data.userId as string;
        const clientType = socket.data.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const sessionId = socket.data.sessionId as string | undefined;
        const machineId = socket.data.machineId as string | undefined;
        const credentialId = socket.data.credentialId as string | undefined;
        const labels = getMetricsLabelsFromSocket(socket);

        log(
            { module: 'websocket' },
            `Token verified: clientType=${clientType || 'user-scoped'}, client=${labels.client}, hasSession=${Boolean(sessionId)}, hasMachine=${Boolean(machineId)}`,
        );

        // Store connection based on type
        const metadata = {
            clientType: clientType || 'user-scoped',
            sessionId,
            machineId,
            credentialId,
        };
        const happyClient = socket.data.happyClient as string | undefined;
        let connection: ClientConnection;
        if (metadata.clientType === 'session-scoped' && sessionId) {
            connection = {
                connectionType: 'session-scoped',
                socket,
                userId,
                sessionId,
                machineId,
                credentialId,
                happyClient
            };
        } else if (metadata.clientType === 'machine-scoped' && machineId) {
            connection = {
                connectionType: 'machine-scoped',
                socket,
                userId,
                machineId,
                credentialId,
                happyClient
            };
        } else {
            connection = {
                connectionType: 'user-scoped',
                socket,
                userId,
                credentialId,
                happyClient
            };
        }
        eventRouter.addConnection(userId, connection);
        websocketConnectionsGauge.inc({ type: connection.connectionType, ...labels });

        // A connection can outlive its initial handshake by hours. Re-check the
        // persistent account state before every incoming event so a deletion
        // marker stops writes on every replica, not only the one that happened
        // to disconnect the socket first.
        socket.use((_event, next) => {
            void auth.verifyToken(socket.data.authToken as string)
                .then((verified) => {
                    if (
                        !verified
                        || verified.userId !== userId
                        || verified.credentialId !== credentialId
                    ) {
                        socket.disconnect(true);
                        next(new Error('Authentication is no longer valid'));
                        return;
                    }
                    next();
                })
                .catch(() => {
                    socket.disconnect(true);
                    next(new Error('Authentication is no longer valid'));
                });
        });

        // Broadcast daemon online status
        if (connection.connectionType === 'machine-scoped') {
            // Broadcast daemon online
            const machineActivity = buildMachineActivityEphemeral(machineId!, true, Date.now());
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        }

        // Track app focus state for push notification routing.
        // State lives on socket.data — no external storage needed.
        // Read initial state from handshake to close the race window between
        // connect and the first async app-state event.
        const initialAppState = socket.handshake.auth.appState as string | undefined;
        if (initialAppState) {
            socket.data.appState = initialAppState === 'active' ? 'active' : 'background';
        }

        socket.on('app-state', (data: { state: string }) => {
            socket.data.appState = data?.state === 'active' ? 'active' : 'background';
        });

        socket.on('disconnect', () => {
            websocketEventsCounter.inc({ event_type: 'disconnect', ...labels });

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            websocketConnectionsGauge.dec({ type: connection.connectionType, ...labels });

            log({
                module: 'websocket',
                userHash: diagnosticHash(userId),
            }, 'User disconnected');

            // Broadcast daemon offline status
            if (connection.connectionType === 'machine-scoped') {
                const machineActivity = buildMachineActivityEphemeral(connection.machineId, false, Date.now());
                eventRouter.emitEphemeral({
                    userId,
                    payload: machineActivity,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }
        });

        // Handlers
        rpcHandler(userId, socket, io);
        usageHandler(userId, socket, connection);
        sessionUpdateHandler(userId, socket, connection);
        pingHandler(socket);
        machineUpdateHandler(userId, socket);
        artifactUpdateHandler(userId, socket);
        accessKeyHandler(userId, socket, connection);

        // Ready
        log({
            module: 'websocket',
            userHash: diagnosticHash(userId),
        }, 'User connected');
    });

    onShutdown('api', async () => {
        await io.close();
    });
}
