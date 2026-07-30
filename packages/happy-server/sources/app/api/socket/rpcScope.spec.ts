import { describe, expect, it } from "vitest";
import { canCallRpcMethod, canRegisterRpcMethod } from "./rpcScope";

describe("RPC socket scope", () => {
    it("lets a machine credential register only its own machine methods", () => {
        const scope = {
            clientType: "machine-scoped" as const,
            credentialId: "credential-1",
            machineId: "machine-1",
        };
        expect(canRegisterRpcMethod(scope, "machine-1:spawn-happy-session")).toBe(true);
        expect(canRegisterRpcMethod(scope, "machine-2:spawn-happy-session")).toBe(false);
    });

    it("lets a session credential register only its own session methods", () => {
        const scope = {
            clientType: "session-scoped" as const,
            credentialId: "credential-1",
            sessionId: "session-1",
        };
        expect(canRegisterRpcMethod(scope, "session-1:abort")).toBe(true);
        expect(canRegisterRpcMethod(scope, "session-2:abort")).toBe(false);
    });

    it("prevents terminal credentials from calling another RPC provider", () => {
        expect(canCallRpcMethod({
            clientType: "session-scoped",
            credentialId: "credential-1",
            sessionId: "session-1",
        }, "machine-2:stop-daemon")).toBe(false);
    });

    it("keeps account user-scoped RPC control available", () => {
        expect(canCallRpcMethod({
            clientType: "user-scoped",
        }, "machine-1:spawn-happy-session")).toBe(true);
    });
});
