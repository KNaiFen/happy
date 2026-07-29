import {
    createSyncV4DiagnosticRecord,
    type SyncV4DiagnosticClientType,
    type SyncV4DiagnosticInput,
    type SyncV4DiagnosticRecord,
} from "@slopus/happy-wire";
import { createHash, randomBytes } from "node:crypto";
import type {
    FastifyBaseLogger,
    FastifyInstance,
    FastifyReply,
    FastifyRequest,
} from "fastify";
import packageJson from "../../../../package.json";

export const SYNC_V4_TRACE_HEADER = "X-Happy-Sync-Trace";

const syncV4TracePattern = /^[0-9a-f]{32}$/;
const syncV4ClientTypes = new Set<SyncV4DiagnosticClientType>([
    "cli-coding-session",
    "ios",
    "android",
    "web",
    "desktop",
    "macos",
    "windows",
]);

interface ServerSyncV4LifecycleState {
    registered: boolean;
    started: boolean;
    closed: boolean;
    featureEnabled: boolean;
    transportSecurity: "https" | "insecureHttp";
    epoch: number;
    records: number;
    pending: number;
    dropped: number;
    suppressed: number;
    invalid: number;
    writeFailures: number;
}

const serverLifecycleStates = new WeakMap<object, ServerSyncV4LifecycleState>();

export function registerServerSyncV4Lifecycle(
    app: FastifyInstance,
    featureEnabled: boolean,
): void {
    const state = serverLifecycleState(app, featureEnabled);
    state.featureEnabled = featureEnabled;
    if (state.registered) return;
    state.registered = true;
    app.addHook("onClose", async (instance) => {
        const current = serverLifecycleStates.get(instance);
        if (!current?.started || current.closed) return;
        current.closed = true;
        const logged = emitServerSyncV4Diagnostic(instance.log, current, {
            level: current.invalid > 0 || current.writeFailures > 0 ? "warn" : "info",
            component: "server.sync",
            event: "lifecycle",
            phase: "exited",
            state: current.invalid > 0 || current.writeFailures > 0 ? "degraded" : "stopped",
            reason: "shutdown",
            softwareVersion: serverSoftwareVersion(),
            protocolVersion: 4,
            featureEnabled: current.featureEnabled,
            transportSecurity: current.transportSecurity,
            epoch: current.epoch,
            count: current.records,
            pending: current.pending,
            dropped: current.dropped,
            suppressed: current.suppressed,
            invalid: current.invalid,
            writeFailures: current.writeFailures,
        });
        if (!logged) logServerSyncV4LifecycleFallback(instance.log, current, "exited");
    });
}

export async function attachSyncV4Trace(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const supplied = request.headers[SYNC_V4_TRACE_HEADER.toLowerCase()];
    const traceId = typeof supplied === "string" && syncV4TracePattern.test(supplied)
        ? supplied
        : randomBytes(16).toString("hex");
    request.syncV4TraceId = traceId;
    reply.header(SYNC_V4_TRACE_HEADER, traceId);
    const state = serverLifecycleState(request.server);
    state.transportSecurity = transportSecurityFromRequest(request);
    if (!state.started) {
        state.started = true;
        const logged = emitServerSyncV4Diagnostic(request.log, state, {
            level: "info",
            component: "server.sync",
            event: "lifecycle",
            phase: "started",
            state: "starting",
            reason: "startup",
            traceId,
            softwareVersion: serverSoftwareVersion(),
            protocolVersion: 4,
            featureEnabled: state.featureEnabled,
            transportSecurity: state.transportSecurity,
            epoch: state.epoch,
            pending: state.pending,
            dropped: state.dropped,
            suppressed: state.suppressed,
            invalid: state.invalid,
            writeFailures: state.writeFailures,
        });
        if (!logged) logServerSyncV4LifecycleFallback(request.log, state, "started");
    }
    if (!request.syncV4LifecycleTracked) {
        request.syncV4LifecycleTracked = true;
        state.pending += 1;
    }
}

export function completeServerSyncV4Request(request: FastifyRequest): void {
    if (!request.syncV4LifecycleTracked) return;
    request.syncV4LifecycleTracked = false;
    const state = serverLifecycleStates.get(request.server);
    if (state) state.pending = Math.max(0, state.pending - 1);
}

export function serverSyncV4DiagnosticHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function logServerSyncV4Diagnostic(
    request: FastifyRequest,
    input: Omit<
        SyncV4DiagnosticInput,
        "clientType" | "component" | "protocolVersion" | "traceId"
    >,
): boolean {
    return emitServerSyncV4Diagnostic(
        request.log,
        serverLifecycleState(request.server),
        {
            component: "server.sync",
            protocolVersion: 4,
            traceId: request.syncV4TraceId,
            clientType: clientTypeFromRequest(request),
            softwareVersion: serverSoftwareVersion(),
            transportSecurity: transportSecurityFromRequest(request),
            ...input,
        },
    );
}

function emitServerSyncV4Diagnostic(
    logger: FastifyBaseLogger,
    state: ServerSyncV4LifecycleState,
    input: SyncV4DiagnosticInput,
): boolean {
    let record: SyncV4DiagnosticRecord;
    try {
        record = createSyncV4DiagnosticRecord(input);
    } catch {
        state.invalid += 1;
        return false;
    }
    try {
        logger[record.level]({ syncV4: record }, "sync_v4");
        state.records += 1;
        return true;
    } catch {
        state.writeFailures += 1;
        return false;
    }
}

function serverLifecycleState(
    server: object,
    featureEnabled: boolean = isSyncV4FeatureEnabled(),
): ServerSyncV4LifecycleState {
    const existing = serverLifecycleStates.get(server);
    if (existing) return existing;
    const state: ServerSyncV4LifecycleState = {
        registered: false,
        started: false,
        closed: false,
        featureEnabled,
        transportSecurity: "https",
        epoch: randomBytes(6).readUIntBE(0, 6),
        records: 0,
        pending: 0,
        dropped: 0,
        suppressed: 0,
        invalid: 0,
        writeFailures: 0,
    };
    serverLifecycleStates.set(server, state);
    return state;
}

function logServerSyncV4LifecycleFallback(
    logger: FastifyBaseLogger,
    state: ServerSyncV4LifecycleState,
    phase: "started" | "exited",
): void {
    const summary = {
        module: "sync-v4-diagnostic",
        event: "lifecycle",
        phase,
        protocolVersion: 4,
        softwareVersion: serverSoftwareVersion(),
        featureEnabled: state.featureEnabled,
        transportSecurity: state.transportSecurity,
        epoch: state.epoch,
        records: state.records,
        pending: state.pending,
        dropped: state.dropped,
        suppressed: state.suppressed,
        invalid: state.invalid,
        writeFailures: state.writeFailures,
    };
    try {
        logger.warn(summary, "sync_v4_diagnostic_fallback");
    } catch {
        try {
            console.warn("sync_v4_diagnostic_fallback", summary);
        } catch {
            // Diagnostics must never affect request or shutdown control flow.
        }
    }
}

function serverSoftwareVersion(): string {
    const override = process.env.HAPPY_SERVER_VERSION ?? process.env.npm_package_version;
    return typeof override === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(override)
        ? override
        : packageJson.version;
}

function isSyncV4FeatureEnabled(): boolean {
    return process.env.HAPPY_CODEX_SYNC_V4_ENABLED === "true"
        || process.env.HAPPY_CODEX_SYNC_V4_ENABLED === "1";
}

function transportSecurityFromRequest(
    request: FastifyRequest,
): "https" | "insecureHttp" {
    const publicUrl = process.env.PUBLIC_URL;
    if (typeof publicUrl === "string" && publicUrl.length > 0) {
        try {
            const protocol = new URL(publicUrl).protocol;
            if (protocol === "https:") return "https";
            if (protocol === "http:") return "insecureHttp";
        } catch {
            // Fall back to the directly observed request protocol.
        }
    }
    try {
        return request.protocol === "https" ? "https" : "insecureHttp";
    } catch {
        return "https";
    }
}

function clientTypeFromRequest(request: FastifyRequest): SyncV4DiagnosticClientType {
    const raw = request.headers["x-happy-client"];
    const clientType = typeof raw === "string"
        ? raw.split("/", 1)[0].toLowerCase() as SyncV4DiagnosticClientType
        : "unknown";
    return syncV4ClientTypes.has(clientType) ? clientType : "unknown";
}
