import { PGlite } from "@electric-sql/pglite";
import { PrismaClient } from "@prisma/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../standalone";
import {
    persistSyncV4MutationWrites,
    type SequencedSyncV4Mutation,
} from "./syncV4MutationPersistence";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
        recursive: true,
        force: true,
    })));
});

function mutation(
    mutationId: string,
    entityId: string,
    revision: number,
    ciphertext: string,
): SequencedSyncV4Mutation["mutation"] {
    return {
        mutationId,
        producerId: "producer-1",
        entityId,
        entityType: "codex.item",
        revision,
        op: "upsert",
        ciphertext,
    };
}

describe("persistSyncV4MutationWrites", () => {
    it("executes the batch SQL and rolls every write back when the journal conflicts", async () => {
        const dataDirectory = await mkdtemp(join(tmpdir(), "happy-sync-v4-batch-"));
        temporaryDirectories.push(dataDirectory);
        const pgliteDirectory = join(dataDirectory, "pglite");
        await runMigrations({
            pgliteDir: pgliteDirectory,
            migrationsDir: resolve("prisma", "migrations"),
        });

        const pg = new PGlite(pgliteDirectory);
        const client = new PrismaClient({ adapter: new PrismaPGlite(pg) } as never);
        try {
            const account = await client.account.create({
                data: { publicKey: `sync-v4-batch-${crypto.randomUUID()}` },
            });
            const successfulSession = await client.session.create({
                data: {
                    accountId: account.id,
                    tag: "sync-v4-batch-success",
                    metadata: "encrypted-metadata",
                },
            });
            const writes: SequencedSyncV4Mutation[] = [
                { mutation: mutation("mutation-1", "entity-1", 1, "ciphertext-1"), status: "accepted", seq: 1 },
                { mutation: mutation("mutation-2", "entity-1", 2, "ciphertext-2"), status: "accepted", seq: 2 },
                { mutation: mutation("mutation-3", "entity-1", 1, "ciphertext-stale"), status: "superseded", seq: 3 },
                {
                    mutation: {
                        ...mutation("mutation-4", "entity-2", 1, "tombstone"),
                        op: "delete",
                    },
                    status: "accepted",
                    seq: 4,
                },
            ];

            await client.$transaction(async (tx) => {
                await tx.session.update({
                    where: { id: successfulSession.id },
                    data: { syncV4Seq: { increment: writes.length } },
                });
                await persistSyncV4MutationWrites(tx, successfulSession.id, writes);
            });

            expect(await client.session.findUniqueOrThrow({
                where: { id: successfulSession.id },
                select: { syncV4Seq: true },
            })).toEqual({ syncV4Seq: 4 });
            expect(await client.sessionEntityV4.findMany({
                where: { sessionId: successfulSession.id },
                orderBy: { entityId: "asc" },
                select: { entityId: true, revision: true, op: true, ciphertext: true, updatedSeq: true },
            })).toEqual([
                { entityId: "entity-1", revision: 2, op: "upsert", ciphertext: "ciphertext-2", updatedSeq: 2 },
                { entityId: "entity-2", revision: 1, op: "delete", ciphertext: "tombstone", updatedSeq: 4 },
            ]);
            expect(await client.sessionMutationV4.findMany({
                where: { sessionId: successfulSession.id },
                orderBy: { seq: "asc" },
                select: { mutationId: true, status: true, seq: true },
            })).toEqual([
                { mutationId: "mutation-1", status: "accepted", seq: 1 },
                { mutationId: "mutation-2", status: "accepted", seq: 2 },
                { mutationId: "mutation-3", status: "superseded", seq: 3 },
                { mutationId: "mutation-4", status: "accepted", seq: 4 },
            ]);

            const rollbackSession = await client.session.create({
                data: {
                    accountId: account.id,
                    tag: "sync-v4-batch-rollback",
                    metadata: "encrypted-metadata",
                },
            });
            const conflictingWrites: SequencedSyncV4Mutation[] = [
                { mutation: mutation("duplicate-id", "entity-a", 1, "ciphertext-a"), status: "accepted", seq: 1 },
                { mutation: mutation("duplicate-id", "entity-b", 1, "ciphertext-b"), status: "accepted", seq: 2 },
            ];

            await expect(client.$transaction(async (tx) => {
                await tx.session.update({
                    where: { id: rollbackSession.id },
                    data: { syncV4Seq: { increment: conflictingWrites.length } },
                });
                await persistSyncV4MutationWrites(tx, rollbackSession.id, conflictingWrites);
            })).rejects.toThrow();

            expect(await client.session.findUniqueOrThrow({
                where: { id: rollbackSession.id },
                select: { syncV4Seq: true },
            })).toEqual({ syncV4Seq: 0 });
            expect(await client.sessionEntityV4.count({
                where: { sessionId: rollbackSession.id },
            })).toBe(0);
            expect(await client.sessionMutationV4.count({
                where: { sessionId: rollbackSession.id },
            })).toBe(0);
        } finally {
            await client.$disconnect();
            await pg.close();
        }
    }, 30_000);
});
