import { readFile } from "node:fs/promises";

const secretFile = process.env.HAPPY_MASTER_SECRET_FILE || "/run/secrets/happy_master_secret";

async function main() {
    let masterSecret;
    try {
        masterSecret = (await readFile(secretFile, "utf8")).replace(/[\r\n]/g, "");
    } catch {
        throw new Error(`Happy relay master secret is not readable: ${secretFile}`);
    }

    if (!/^[0-9a-fA-F]{64}$/.test(masterSecret)) {
        throw new Error("Happy relay master secret must contain exactly 64 hexadecimal characters");
    }

    process.env.HANDY_MASTER_SECRET = masterSecret;
    masterSecret = undefined;

    const { runMigrations, serve } = await import("./dist/standalone.mjs");
    await runMigrations();
    await serve();
}

main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Happy relay startup failed: ${message}`);
    process.exit(1);
});
