import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    attachSyncV4Trace,
    completeServerSyncV4Request,
    logServerSyncV4Diagnostic,
    registerServerSyncV4Lifecycle,
    serverSyncV4DiagnosticHash,
    SYNC_V4_TRACE_HEADER,
} from "./syncV4Diagnostics";

function request(traceHeader?: unknown, server: object = {}) {
    const log = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
    return {
        headers: traceHeader === undefined
            ? {}
            : { [SYNC_V4_TRACE_HEADER.toLowerCase()]: traceHeader },
        log,
        server,
        syncV4TraceId: undefined as string | undefined,
        protocol: "http",
    };
}

describe("Sync v4 server diagnostics", () => {
    beforeEach(() => {
        vi.stubEnv("PUBLIC_URL", "");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("echoes a valid trace ID and generates one for invalid input", async () => {
        const valid = request("00000000000000000000000000000001");
        const validReply = { header: vi.fn() };
        await attachSyncV4Trace(valid as never, validReply as never);
        expect(valid.syncV4TraceId).toBe("00000000000000000000000000000001");
        expect(validReply.header).toHaveBeenCalledWith(
            "X-Happy-Sync-Trace",
            "00000000000000000000000000000001",
        );

        const invalid = request("prompt-reasoning-tool-output-secret");
        const invalidReply = { header: vi.fn() };
        await attachSyncV4Trace(invalid as never, invalidReply as never);
        expect(invalid.syncV4TraceId).toMatch(/^[0-9a-f]{32}$/);
        expect(invalid.syncV4TraceId).not.toContain("prompt");
    });

    it("writes only the strict diagnostic record and never the supplied error object", () => {
        const secret = "prompt-reasoning-tool-output-secret";
        const value = request("00000000000000000000000000000001");
        value.syncV4TraceId = "00000000000000000000000000000001";

        logServerSyncV4Diagnostic(value as never, {
            level: "warn",
            event: "transport",
            phase: "failed",
            transportOperation: "changes",
            errorKind: "network",
            sessionHash: serverSyncV4DiagnosticHash("session-1"),
        });

        expect(value.log.warn).toHaveBeenCalledOnce();
        const serialized = JSON.stringify(value.log.warn.mock.calls);
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain("session-1");
        expect(serialized).toContain("server.sync");
        expect(serialized).toContain("00000000000000000000000000000001");
        expect(serialized).toContain('"transportSecurity":"insecureHttp"');
    });

    it("uses the canonical public URL security mode behind a TLS-terminating proxy", async () => {
        vi.stubEnv("PUBLIC_URL", "https://relay.example.test");
        const value = request("00000000000000000000000000000001");

        await attachSyncV4Trace(value as never, { header: vi.fn() } as never);

        const startup = value.log.info.mock.calls[0]?.[0]?.syncV4;
        expect(startup).toMatchObject({
            event: "lifecycle",
            phase: "started",
            transportSecurity: "https",
        });
        expect(JSON.stringify(value.log.info.mock.calls)).not.toContain("relay.example.test");
    });

    it("drops invalid extra payload fields without throwing or logging plaintext", () => {
        const secret = "prompt-reasoning-tool-output-secret";
        const value = request("00000000000000000000000000000001");
        value.syncV4TraceId = "00000000000000000000000000000001";

        expect(() => logServerSyncV4Diagnostic(value as never, {
            level: "error",
            event: "transport",
            phase: "failed",
            payload: { prompt: secret },
        } as never)).not.toThrow();

        expect(value.log.error).not.toHaveBeenCalled();
        expect(JSON.stringify(value.log)).not.toContain(secret);
    });

    it("falls back without interrupting request tracking when the structured logger fails", async () => {
        const secret = "prompt-reasoning-tool-output-secret";
        const value = request("00000000000000000000000000000001");
        value.log.info.mockImplementation(() => {
            throw new Error(secret);
        });

        await expect(attachSyncV4Trace(
            value as never,
            { header: vi.fn() } as never,
        )).resolves.toBeUndefined();

        expect(value.syncV4TraceId).toBe("00000000000000000000000000000001");
        expect(value.log.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                module: "sync-v4-diagnostic",
                phase: "started",
                writeFailures: 1,
            }),
            "sync_v4_diagnostic_fallback",
        );
        expect(JSON.stringify(value.log.warn.mock.calls)).not.toContain(secret);
        expect(() => completeServerSyncV4Request(value as never)).not.toThrow();
    });

    it("writes one startup fingerprint and one terminal summary per server instance", async () => {
        const hooks: Array<(instance: object) => Promise<void>> = [];
        const serverLog = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        };
        const server = {
            log: serverLog,
            addHook: vi.fn((name: string, hook: (instance: object) => Promise<void>) => {
                expect(name).toBe("onClose");
                hooks.push(hook);
            }),
        };
        registerServerSyncV4Lifecycle(server as never, true);
        registerServerSyncV4Lifecycle(server as never, true);

        const first = request("00000000000000000000000000000001", server);
        first.log = serverLog;
        const second = request("00000000000000000000000000000002", server);
        second.log = serverLog;
        await attachSyncV4Trace(first as never, { header: vi.fn() } as never);
        await attachSyncV4Trace(second as never, { header: vi.fn() } as never);
        completeServerSyncV4Request(first as never);
        completeServerSyncV4Request(second as never);
        await hooks[0](server);

        expect(hooks).toHaveLength(1);
        const records = [
            ...serverLog.debug.mock.calls,
            ...serverLog.info.mock.calls,
            ...serverLog.warn.mock.calls,
            ...serverLog.error.mock.calls,
        ].flatMap((call) => call[0]?.syncV4 ? [call[0].syncV4] : []);
        expect(records.filter((record) => record.event === "lifecycle")).toHaveLength(2);
        expect(records[0]).toMatchObject({
            component: "server.sync",
            event: "lifecycle",
            phase: "started",
            state: "starting",
            featureEnabled: true,
            transportSecurity: "insecureHttp",
            protocolVersion: 4,
            pending: 0,
        });
        expect(records[0].softwareVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(records[1]).toMatchObject({
            component: "server.sync",
            event: "lifecycle",
            phase: "exited",
            state: "stopped",
            featureEnabled: true,
            transportSecurity: "insecureHttp",
            protocolVersion: 4,
            pending: 0,
            dropped: 0,
            suppressed: 0,
            invalid: 0,
            writeFailures: 0,
        });
        expect(records[1].epoch).toBe(records[0].epoch);
        expect(records[1].softwareVersion).toBe(records[0].softwareVersion);
    });
});
