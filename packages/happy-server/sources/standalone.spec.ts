import { describe, expect, it } from "vitest";
import { isStandaloneEntrypoint, reportStandaloneFailure } from "./standalone";

describe("isStandaloneEntrypoint", () => {
    it("recognizes standalone script paths on Windows and POSIX", () => {
        expect(isStandaloneEntrypoint("C:\\Projects\\Work\\happy\\packages\\happy-server\\sources\\standalone.ts")).toBe(true);
        expect(isStandaloneEntrypoint("/repo/packages/happy-server/sources/standalone.ts")).toBe(true);
        expect(isStandaloneEntrypoint("/repo/packages/happy-server/dist/happy-server")).toBe(true);
        expect(isStandaloneEntrypoint("C:\\repo\\packages\\happy-server\\dist\\happy-server.exe")).toBe(true);
    });

    it("rejects unrelated entrypoints", () => {
        expect(isStandaloneEntrypoint("C:\\repo\\node_modules\\vitest\\vitest.mjs")).toBe(false);
        expect(isStandaloneEntrypoint("/repo/packages/happy-server/sources/main.ts")).toBe(false);
    });
});

describe("reportStandaloneFailure", () => {
    it("never serializes underlying migration or startup errors", () => {
        const hostile = "prompt-reasoning-tool-output-standalone";
        const error = ((...args: unknown[]) => {
            expect(JSON.stringify(args)).not.toContain(hostile);
        });

        reportStandaloneFailure("migration", { error });
        reportStandaloneFailure("server", { error });
    });
});
