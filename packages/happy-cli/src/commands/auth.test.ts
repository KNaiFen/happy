import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    readCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    clearMachineId: vi.fn(),
    readSettings: vi.fn(),
    authAndSetupMachineIfNeeded: vi.fn(),
    apiCreate: vi.fn(),
    getOrCreateMachine: vi.fn(),
    stopDaemon: vi.fn(),
    checkDaemon: vi.fn(),
}));

vi.mock("@/persistence", () => ({
    readCredentials: mocks.readCredentials,
    clearCredentials: mocks.clearCredentials,
    clearMachineId: mocks.clearMachineId,
    readSettings: mocks.readSettings,
}));
vi.mock("@/ui/auth", () => ({
    authAndSetupMachineIfNeeded: mocks.authAndSetupMachineIfNeeded,
}));
vi.mock("@/configuration", () => ({
    configuration: { happyHomeDir: "/tmp/happy-test" },
}));
vi.mock("@/daemon/controlClient", () => ({
    stopDaemon: mocks.stopDaemon,
    checkIfDaemonRunningAndCleanupStaleState: mocks.checkDaemon,
}));
vi.mock("@/ui/logger", () => ({
    logger: { debug: vi.fn() },
}));
vi.mock("@/api/api", () => ({
    ApiClient: { create: mocks.apiCreate },
}));
vi.mock("@/daemon/initialMachineMetadata", () => ({
    initialMachineMetadata: {
        host: "test-host",
        platform: "darwin",
        happyCliVersion: "1.4.7",
    },
}));

import { handleAuthCommand } from "./auth";

describe("happy auth login machine registration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readCredentials.mockResolvedValue(null);
        mocks.readSettings.mockResolvedValue(null);
        mocks.authAndSetupMachineIfNeeded.mockResolvedValue({
            credentials: {
                token: "terminal-token",
                encryption: {
                    type: "legacy",
                    secret: new Uint8Array(32),
                },
            },
            machineId: "machine-1",
        });
        mocks.getOrCreateMachine.mockResolvedValue({ id: "machine-1" });
        mocks.apiCreate.mockResolvedValue({
            getOrCreateMachine: mocks.getOrCreateMachine,
        });
    });

    it("registers the machine before reporting QR authentication success", async () => {
        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
        try {
            await handleAuthCommand(["login"]);
        } finally {
            consoleLog.mockRestore();
        }

        expect(mocks.apiCreate).toHaveBeenCalledWith(
            expect.objectContaining({ token: "terminal-token" }),
        );
        expect(mocks.getOrCreateMachine).toHaveBeenCalledWith({
            machineId: "machine-1",
            metadata: expect.objectContaining({
                host: "test-host",
                happyCliVersion: "1.4.7",
            }),
        });
    });

    it("revalidates locally cached credentials and machine identity with the relay", async () => {
        const credentials = {
            token: "cached-terminal-token",
            encryption: {
                type: "legacy" as const,
                secret: new Uint8Array(32),
            },
        };
        mocks.readCredentials.mockResolvedValue(credentials);
        mocks.readSettings.mockResolvedValue({ machineId: "machine-cached" });
        mocks.authAndSetupMachineIfNeeded.mockResolvedValue({
            credentials,
            machineId: "machine-cached",
        });
        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
        try {
            await handleAuthCommand(["login"]);
        } finally {
            consoleLog.mockRestore();
        }

        expect(mocks.authAndSetupMachineIfNeeded).toHaveBeenCalledOnce();
        expect(mocks.getOrCreateMachine).toHaveBeenCalledWith({
            machineId: "machine-cached",
            metadata: expect.objectContaining({
                host: "test-host",
                happyCliVersion: "1.4.7",
            }),
        });
    });
});
