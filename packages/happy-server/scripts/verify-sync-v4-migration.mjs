import { spawnSync } from "node:child_process";
import {
    cpSync,
    mkdtempSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const syncV4Migration = "20260728123500_add_codex_sync_v4";
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(serverRoot, "prisma", "schema.prisma");
const migrationsPath = join(serverRoot, "prisma", "migrations");
const prismaCli = resolve(serverRoot, "..", "..", "node_modules", "prisma", "build", "index.js");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
}
if (process.env.HAPPY_MIGRATION_TEST_ALLOW_RESET !== "1") {
    throw new Error("HAPPY_MIGRATION_TEST_ALLOW_RESET=1 is required");
}

const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (!localHosts.has(parsedDatabaseUrl.hostname) || !databaseName.includes("_migration_test")) {
    throw new Error(
        "Migration verification only resets a local database whose name contains _migration_test",
    );
}

function runPrisma(args, input) {
    const result = spawnSync(process.execPath, [prismaCli, ...args], {
        cwd: serverRoot,
        env: process.env,
        encoding: "utf8",
        input,
        stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Prisma command failed (${result.status}): ${args.join(" ")}`);
    }
}

function resetPublicSchema() {
    runPrisma(["db", "execute", "--stdin", "--schema", schemaPath], `
        DROP SCHEMA IF EXISTS public CASCADE;
        CREATE SCHEMA public;
        GRANT ALL ON SCHEMA public TO CURRENT_USER;
        GRANT ALL ON SCHEMA public TO public;
    `);
}

function deploy(schema) {
    runPrisma(["migrate", "deploy", "--schema", schema]);
}

function assertNoSchemaDrift() {
    runPrisma([
        "migrate",
        "diff",
        "--exit-code",
        "--from-schema-datasource",
        schemaPath,
        "--to-schema-datamodel",
        schemaPath,
    ]);
}

function assertSyncV4Schema({ expectMigratedSession }) {
    const migratedSessionCheck = expectMigratedSession
        ? `
            IF NOT EXISTS (
                SELECT 1
                FROM "Session"
                WHERE "id" = 'migration-existing-session' AND "syncV4Seq" = 0
            ) THEN
                RAISE EXCEPTION 'existing Session row or syncV4Seq default was not preserved';
            END IF;
        `
        : "";

    runPrisma(["db", "execute", "--stdin", "--schema", schemaPath], `
        DO $$
        BEGIN
            IF to_regclass('"SessionEntityV4"') IS NULL
                OR to_regclass('"SessionMutationV4"') IS NULL THEN
                RAISE EXCEPTION 'Sync v4 tables are missing';
            END IF;
            IF to_regclass('"SessionEntityV4_sessionId_entityId_key"') IS NULL
                OR to_regclass('"SessionEntityV4_sessionId_updatedSeq_idx"') IS NULL
                OR to_regclass('"SessionMutationV4_sessionId_mutationId_key"') IS NULL
                OR to_regclass('"SessionMutationV4_sessionId_seq_key"') IS NULL
                OR to_regclass('"SessionMutationV4_sessionId_createdAt_idx"') IS NULL
                OR to_regclass('"SessionMutationV4_sessionId_prunedAt_seq_idx"') IS NULL THEN
                RAISE EXCEPTION 'Sync v4 indexes are missing';
            END IF;
            ${migratedSessionCheck}
        END
        $$;

        INSERT INTO "Account" ("id", "publicKey", "updatedAt")
        VALUES ('migration-cascade-account', 'migration-cascade-public-key', CURRENT_TIMESTAMP);
        INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt")
        VALUES (
            'migration-cascade-session',
            'migration-cascade-tag',
            'migration-cascade-account',
            '{}',
            CURRENT_TIMESTAMP
        );
        INSERT INTO "SessionEntityV4" (
            "id", "sessionId", "producerId", "entityId", "entityType",
            "revision", "op", "ciphertext", "updatedSeq", "updatedAt"
        )
        VALUES (
            'migration-entity-row',
            'migration-cascade-session',
            'producer',
            'entity',
            'codex.item',
            1,
            'upsert',
            'ciphertext',
            1,
            CURRENT_TIMESTAMP
        );
        INSERT INTO "SessionMutationV4" (
            "id", "sessionId", "mutationId", "producerId", "entityId",
            "entityType", "revision", "op", "ciphertext", "contentHash",
            "status", "seq"
        )
        VALUES (
            'migration-mutation-row',
            'migration-cascade-session',
            'mutation',
            'producer',
            'entity',
            'codex.item',
            1,
            'upsert',
            'ciphertext',
            'content-hash',
            'accepted',
            1
        );

        DO $$
        BEGIN
            BEGIN
                INSERT INTO "SessionMutationV4" (
                    "id", "sessionId", "mutationId", "producerId", "entityId",
                    "entityType", "revision", "op", "ciphertext", "contentHash",
                    "status", "seq"
                )
                VALUES (
                    'migration-duplicate-row',
                    'migration-cascade-session',
                    'mutation',
                    'producer',
                    'entity-2',
                    'codex.item',
                    1,
                    'upsert',
                    'ciphertext',
                    'content-hash-2',
                    'accepted',
                    2
                );
                RAISE EXCEPTION 'duplicate mutationId was accepted';
            EXCEPTION
                WHEN unique_violation THEN NULL;
            END;
        END
        $$;

        DELETE FROM "Session" WHERE "id" = 'migration-cascade-session';

        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM "SessionEntityV4"
                WHERE "sessionId" = 'migration-cascade-session'
            ) OR EXISTS (
                SELECT 1 FROM "SessionMutationV4"
                WHERE "sessionId" = 'migration-cascade-session'
            ) THEN
                RAISE EXCEPTION 'Sync v4 session cascade did not remove child rows';
            END IF;
        END
        $$;
    `);
}

function createPreSyncV4MigrationTree(tempRoot) {
    const tempPrismaPath = join(tempRoot, "prisma");
    const tempMigrationsPath = join(tempPrismaPath, "migrations");
    mkdirSync(tempMigrationsPath, { recursive: true });
    writeFileSync(join(tempPrismaPath, "schema.prisma"), readFileSync(schemaPath));
    cpSync(
        join(migrationsPath, "migration_lock.toml"),
        join(tempMigrationsPath, "migration_lock.toml"),
    );
    for (const entry of readdirSync(migrationsPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name >= syncV4Migration) continue;
        cpSync(
            join(migrationsPath, entry.name),
            join(tempMigrationsPath, entry.name),
            { recursive: true },
        );
    }
    return join(tempPrismaPath, "schema.prisma");
}

console.log("Verifying Sync v4 migration on a clean PostgreSQL database...");
resetPublicSchema();
deploy(schemaPath);
assertNoSchemaDrift();
assertSyncV4Schema({ expectMigratedSession: false });

const tempRoot = mkdtempSync(join(tmpdir(), "happy-sync-v4-migration-"));
try {
    console.log("Verifying Sync v4 migration from the previous PostgreSQL schema...");
    resetPublicSchema();
    const oldSchemaPath = createPreSyncV4MigrationTree(tempRoot);
    deploy(oldSchemaPath);
    runPrisma(["db", "execute", "--stdin", "--schema", schemaPath], `
        INSERT INTO "Account" ("id", "publicKey", "updatedAt")
        VALUES ('migration-existing-account', 'migration-existing-public-key', CURRENT_TIMESTAMP);
        INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt")
        VALUES (
            'migration-existing-session',
            'migration-existing-tag',
            'migration-existing-account',
            '{"existing":true}',
            CURRENT_TIMESTAMP
        );
    `);
    deploy(schemaPath);
    assertNoSchemaDrift();
    assertSyncV4Schema({ expectMigratedSession: true });
} finally {
    rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Sync v4 migration verification passed.");
