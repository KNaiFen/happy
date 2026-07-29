import { PGlite } from "@electric-sql/pglite";
import { PrismaClient } from "@prisma/client";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite as PGlite0316 } from "pglite-0316";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaPGlite as PrismaPGlite072 } from "pglite-prisma-adapter-072";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../standalone";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(directory => rm(directory, {
            recursive: true,
            force: true,
        })),
    );
});

async function createLegacyRuntimeVolume(
    pgliteDirectory: string,
    migrationsDirectory: string,
): Promise<void> {
    const pg = new PGlite0316(pgliteDirectory);
    try {
        await pg.exec(`
            CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
                "id" TEXT PRIMARY KEY,
                "migration_name" TEXT NOT NULL UNIQUE,
                "finished_at" TIMESTAMPTZ,
                "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
                "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
                "logs" TEXT
            );
        `);
        const migrationNames = (await readdir(migrationsDirectory, {
            withFileTypes: true,
        }))
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort();
        for (const migrationName of migrationNames) {
            const migrationSql = await readFile(
                join(migrationsDirectory, migrationName, "migration.sql"),
                "utf8",
            );
            await pg.exec(migrationSql);
            await pg.query(
                `INSERT INTO "_prisma_migrations"
                    ("id", "migration_name", "finished_at", "applied_steps_count")
                 VALUES ($1, $2, now(), 1)`,
                [crypto.randomUUID(), migrationName],
            );
        }
    } finally {
        await pg.close();
    }
}

describe("PGlite Prisma Bytes compatibility", () => {
    it("round-trips encrypted business fields after closing and reopening the database", async () => {
        const dataDirectory = await mkdtemp(join(tmpdir(), "happy-pglite-bytes-"));
        temporaryDirectories.push(dataDirectory);
        const pgliteDirectory = join(dataDirectory, "pglite");

        await runMigrations({
            pgliteDir: pgliteDirectory,
            migrationsDir: resolve("prisma", "migrations"),
        });

        const expectedKey = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
        const expectedHeader = new Uint8Array([9, 8, 7]);
        const expectedBody = new Uint8Array([6, 5, 4, 3]);

        const firstPglite = new PGlite(pgliteDirectory);
        const firstClient = new PrismaClient({
            adapter: new PrismaPGlite(firstPglite),
        } as never);
        const account = await firstClient.account.create({
            data: { publicKey: `pglite-bytes-${crypto.randomUUID()}` },
        });
        await firstClient.machine.create({
            data: {
                id: crypto.randomUUID(),
                accountId: account.id,
                metadata: "encrypted-machine-metadata",
                dataEncryptionKey: expectedKey,
            },
        });
        await firstClient.session.create({
            data: {
                accountId: account.id,
                tag: "pglite-byte-session",
                metadata: "encrypted-session-metadata",
                dataEncryptionKey: expectedKey,
            },
        });
        await firstClient.artifact.create({
            data: {
                id: crypto.randomUUID(),
                accountId: account.id,
                header: expectedHeader,
                body: expectedBody,
                dataEncryptionKey: expectedKey,
            },
        });
        const githubUserId = `pglite-bytes-${crypto.randomUUID()}`;
        await firstClient.githubUser.create({
            data: {
                id: githubUserId,
                profile: {
                    id: 1,
                    login: githubUserId,
                    type: "User",
                    site_admin: false,
                    avatar_url: "",
                    gravatar_id: null,
                    name: null,
                    company: null,
                    blog: null,
                    location: null,
                    email: null,
                    hireable: null,
                    bio: null,
                    twitter_username: null,
                    public_repos: 0,
                    public_gists: 0,
                    followers: 0,
                    following: 0,
                    created_at: "2026-01-01T00:00:00Z",
                    updated_at: "2026-01-01T00:00:00Z",
                },
                token: expectedKey,
            },
        });
        await firstClient.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "pglite-byte-vendor",
                token: expectedKey,
            },
        });
        await firstClient.userKVStore.create({
            data: {
                accountId: account.id,
                key: "pglite-byte-value",
                value: expectedBody,
            },
        });
        await firstClient.$disconnect();
        await firstPglite.close();

        const secondPglite = new PGlite(pgliteDirectory);
        const secondClient = new PrismaClient({
            adapter: new PrismaPGlite(secondPglite),
        } as never);
        const [
            machine,
            session,
            artifact,
            githubUser,
            serviceAccountToken,
            userKVStore,
        ] = await Promise.all([
            secondClient.machine.findFirstOrThrow({ where: { accountId: account.id } }),
            secondClient.session.findFirstOrThrow({ where: { accountId: account.id } }),
            secondClient.artifact.findFirstOrThrow({ where: { accountId: account.id } }),
            secondClient.githubUser.findUniqueOrThrow({ where: { id: githubUserId } }),
            secondClient.serviceAccountToken.findUniqueOrThrow({
                where: {
                    accountId_vendor: {
                        accountId: account.id,
                        vendor: "pglite-byte-vendor",
                    },
                },
            }),
            secondClient.userKVStore.findUniqueOrThrow({
                where: {
                    accountId_key: {
                        accountId: account.id,
                        key: "pglite-byte-value",
                    },
                },
            }),
        ]);

        expect(Array.from(machine.dataEncryptionKey ?? [])).toEqual(Array.from(expectedKey));
        expect(Array.from(session.dataEncryptionKey ?? [])).toEqual(Array.from(expectedKey));
        expect(Array.from(artifact.dataEncryptionKey)).toEqual(Array.from(expectedKey));
        expect(Array.from(artifact.header)).toEqual(Array.from(expectedHeader));
        expect(Array.from(artifact.body)).toEqual(Array.from(expectedBody));
        expect(Array.from(githubUser.token ?? [])).toEqual(Array.from(expectedKey));
        expect(Array.from(serviceAccountToken.token)).toEqual(Array.from(expectedKey));
        expect(Array.from(userKVStore.value ?? [])).toEqual(Array.from(expectedBody));

        await secondClient.$disconnect();
        await secondPglite.close();
    }, 30_000);

    it("opens a 0.3.16-written volume without changing IDs or encrypted keys", async () => {
        const dataDirectory = await mkdtemp(join(tmpdir(), "happy-pglite-upgrade-"));
        temporaryDirectories.push(dataDirectory);
        const pgliteDirectory = join(dataDirectory, "pglite");

        await createLegacyRuntimeVolume(
            pgliteDirectory,
            resolve("prisma", "migrations"),
        );

        const accountPublicKey = `pglite-upgrade-${crypto.randomUUID()}`;
        const machineId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();
        const sessionTag = `pglite-upgrade-session-${crypto.randomUUID()}`;
        const machineKey = new Uint8Array([0, 3, 16, 127, 128, 254, 255]);
        const sessionKey = new Uint8Array([255, 254, 128, 127, 16, 3, 0]);
        const legacyPglite = new PGlite0316(pgliteDirectory);
        const legacyClient = new PrismaClient({
            adapter: new PrismaPGlite072(legacyPglite as never),
        } as never);
        const account = await legacyClient.account.create({
            data: { publicKey: accountPublicKey },
        });
        await expect(legacyClient.machine.create({
            data: {
                id: machineId,
                accountId: account.id,
                metadata: "legacy-encrypted-machine-metadata",
                dataEncryptionKey: machineKey,
            },
        })).rejects.toMatchObject({ code: "P2023" });
        await expect(legacyClient.session.create({
            data: {
                id: sessionId,
                accountId: account.id,
                tag: sessionTag,
                metadata: "legacy-encrypted-session-metadata",
                dataEncryptionKey: sessionKey,
            },
        })).rejects.toMatchObject({ code: "P2023" });
        await legacyClient.$disconnect();
        await legacyPglite.close();

        const currentPglite = new PGlite(pgliteDirectory);
        const currentClient = new PrismaClient({
            adapter: new PrismaPGlite(currentPglite),
        } as never);
        const [reopenedAccount, reopenedMachine, reopenedSession] = await Promise.all([
            currentClient.account.findUniqueOrThrow({
                where: { publicKey: accountPublicKey },
            }),
            currentClient.machine.findUniqueOrThrow({
                where: { id: machineId },
            }),
            currentClient.session.findUniqueOrThrow({
                where: { id: sessionId },
            }),
        ]);

        expect(reopenedAccount.id).toBe(account.id);
        expect(reopenedMachine.id).toBe(machineId);
        expect(reopenedSession.id).toBe(sessionId);
        expect(reopenedSession.tag).toBe(sessionTag);
        expect(Array.from(reopenedMachine.dataEncryptionKey ?? [])).toEqual(
            Array.from(machineKey),
        );
        expect(Array.from(reopenedSession.dataEncryptionKey ?? [])).toEqual(
            Array.from(sessionKey),
        );

        await currentClient.$disconnect();
        await currentPglite.close();
    }, 30_000);
});
