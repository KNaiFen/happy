import {
    classifySyncV4Mutations,
    MutationConflictError,
    RevisionConflictError,
} from "@/app/api/routes/syncV4MutationClassifier";
import { eventRouter } from "@/app/events/eventRouter";
import {
    getMetricsLabelsFromRequest,
    syncV4MutationResultsCounter,
    syncV4ProjectionLagHistogram,
    syncV4SnapshotFallbackCounter,
} from "@/app/monitoring/metrics2";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    isSyncV4VersionAtLeast,
    MAX_SYNC_V4_MUTATIONS_PER_BATCH,
    SyncMutationBatchV4Schema,
    SyncMutationV4Schema,
} from "@slopus/happy-wire";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type Fastify } from "../types";

const JOURNAL_MINIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const JOURNAL_MINIMUM_RECENT_RECORDS = 100_000;
const JOURNAL_CLEANUP_INTERVAL = 1_024;
const MINIMUM_HAPPY_CLI_VERSION = "1.4.2";
const MINIMUM_HAPPY_APP_VERSION = "1.11.4";
const MINIMUM_CODEX_CLI_VERSION = "0.145.0";

type SyncV4ClientCompatibility =
    | { compatible: true }
    | { compatible: false; clientType: "happy-cli" | "happy-app" | "unknown"; minimumVersion: string | null };

export function getSyncV4ClientCompatibility(header: unknown): SyncV4ClientCompatibility {
    if (typeof header !== "string") {
        return { compatible: false, clientType: "unknown", minimumVersion: null };
    }
    const match = /^([^/]+)\/(\d+\.\d+\.\d+)$/.exec(header);
    if (!match) return { compatible: false, clientType: "unknown", minimumVersion: null };
    const [, rawClientType, version] = match;
    if (rawClientType === "cli-coding-session") {
        return isSyncV4VersionAtLeast(version, MINIMUM_HAPPY_CLI_VERSION)
            ? { compatible: true }
            : { compatible: false, clientType: "happy-cli", minimumVersion: MINIMUM_HAPPY_CLI_VERSION };
    }
    if (["ios", "android", "web", "desktop", "macos", "windows"].includes(rawClientType)) {
        return isSyncV4VersionAtLeast(version, MINIMUM_HAPPY_APP_VERSION)
            ? { compatible: true }
            : { compatible: false, clientType: "happy-app", minimumVersion: MINIMUM_HAPPY_APP_VERSION };
    }
    return { compatible: false, clientType: "unknown", minimumVersion: null };
}

async function requireCompatibleSyncV4Client(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const compatibility = getSyncV4ClientCompatibility(request.headers["x-happy-client"]);
    if (compatibility.compatible) return;
    await reply.code(426).send({
        error: "syncV4UpgradeRequired",
        clientType: compatibility.clientType,
        minimumVersion: compatibility.minimumVersion,
    });
}

export function isCodexSyncV4Enabled(
    value: string | undefined = process.env.HAPPY_CODEX_SYNC_V4_ENABLED,
): boolean {
    return value === "true" || value === "1";
}

export function v4CapabilitiesRoutes(app: Fastify): void {
    app.get("/v4/capabilities", async (_request, reply) => reply.send({
        codex: {
            enabled: isCodexSyncV4Enabled(),
            protocolVersion: 4,
            minimumHappyCliVersion: MINIMUM_HAPPY_CLI_VERSION,
            minimumHappyAppVersion: MINIMUM_HAPPY_APP_VERSION,
            minimumCodexCliVersion: MINIMUM_CODEX_CLI_VERSION,
        },
    }));
}

const changesQuerySchema = z.object({
    after_seq: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
});

const snapshotQuerySchema = z.object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
});

const mutationsBodySchema = z.object({
    mutations: z.array(SyncMutationV4Schema).min(1).max(MAX_SYNC_V4_MUTATIONS_PER_BATCH),
}).strict();

function encodeSnapshotCursor(highWatermark: number, entityId: string): string {
    return `${highWatermark}:${entityId}`;
}

function decodeSnapshotCursor(cursor: string | undefined): { highWatermark: number; entityId: string } | null {
    if (!cursor) return null;
    const separator = cursor.indexOf(":");
    if (separator <= 0 || separator === cursor.length - 1) return null;
    const highWatermark = Number(cursor.slice(0, separator));
    if (!Number.isSafeInteger(highWatermark) || highWatermark < 0) return null;
    return { highWatermark, entityId: cursor.slice(separator + 1) };
}

async function findOwnedSession(sessionId: string, accountId: string) {
    return db.session.findFirst({
        where: { id: sessionId, accountId },
        select: { id: true, syncV4Seq: true },
    });
}

/**
 * Removes journal rows only after both safety windows have elapsed. Current
 * entity snapshots remain available, so expired cursors can always recover.
 */
async function pruneMutationJournal(
    sessionId: string,
    previousHighWatermark: number,
    highWatermark: number,
): Promise<void> {
    const previousCleanupBucket = Math.floor(previousHighWatermark / JOURNAL_CLEANUP_INTERVAL);
    const currentCleanupBucket = Math.floor(highWatermark / JOURNAL_CLEANUP_INTERVAL);
    if (currentCleanupBucket <= previousCleanupBucket) return;
    const maximumPrunableSeq = highWatermark - JOURNAL_MINIMUM_RECENT_RECORDS;
    if (maximumPrunableSeq <= 0) return;
    await db.sessionMutationV4.deleteMany({
        where: {
            sessionId,
            seq: { lte: maximumPrunableSeq },
            createdAt: { lt: new Date(Date.now() - JOURNAL_MINIMUM_AGE_MS) },
        },
    });
}

export function v4SessionRoutes(app: Fastify): void {
    app.post("/v4/sessions/:sessionId/mutations", {
        preHandler: [app.authenticate, requireCompatibleSyncV4Client],
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: mutationsBodySchema,
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const session = await findOwnedSession(sessionId, request.userId);
        if (!session) return reply.code(404).send({ error: "Session not found" });
        const validatedBody = SyncMutationBatchV4Schema.safeParse(request.body);
        if (!validatedBody.success) {
            return reply.code(400).send({ error: "Invalid mutation batch" });
        }

        try {
            const result = await inTx(async (tx) => {
                const mutations = validatedBody.data.mutations;
                const mutationIds = mutations.map((mutation) => mutation.mutationId);
                const entityIds = [...new Set(mutations.map((mutation) => mutation.entityId))];
                const existingMutations = await tx.sessionMutationV4.findMany({
                    where: { sessionId, mutationId: { in: mutationIds } },
                });
                const existingEntities = await tx.sessionEntityV4.findMany({
                    where: { sessionId, entityId: { in: entityIds } },
                });
                const mutationsById = new Map(existingMutations.map((mutation) => [mutation.mutationId, mutation]));
                const entitiesById = new Map(existingEntities.map((entity) => [entity.entityId, {
                    producerId: entity.producerId,
                    entityId: entity.entityId,
                    entityType: entity.entityType,
                    revision: entity.revision,
                    op: entity.op,
                    ciphertext: entity.ciphertext,
                }]));
                const classifications = classifySyncV4Mutations({
                    mutations,
                    existingMutations: mutationsById,
                    currentEntities: entitiesById,
                });

                const newClassifications = classifications.filter((classification) => classification.status !== "duplicate");
                let nextSeq = session.syncV4Seq + 1;
                let highWatermark = session.syncV4Seq;
                if (newClassifications.length > 0) {
                    const updatedSession = await tx.session.update({
                        where: { id: sessionId },
                        data: { syncV4Seq: { increment: newClassifications.length } },
                        select: { syncV4Seq: true },
                    });
                    highWatermark = updatedSession.syncV4Seq;
                    nextSeq = highWatermark - newClassifications.length + 1;
                }

                const acknowledgements = [];
                for (const classification of classifications) {
                    if (classification.status === "duplicate") {
                        acknowledgements.push({
                            mutationId: classification.mutation.mutationId,
                            seq: classification.existingSeq!,
                            revision: classification.mutation.revision,
                            status: "duplicate" as const,
                        });
                        continue;
                    }

                    const seq = nextSeq++;
                    const mutation = classification.mutation;
                    if (classification.status === "accepted") {
                        await tx.sessionEntityV4.upsert({
                            where: { sessionId_entityId: { sessionId, entityId: mutation.entityId } },
                            create: {
                                sessionId,
                                producerId: mutation.producerId,
                                entityId: mutation.entityId,
                                entityType: mutation.entityType,
                                revision: mutation.revision,
                                op: mutation.op,
                                ciphertext: mutation.ciphertext,
                                updatedSeq: seq,
                            },
                            update: {
                                producerId: mutation.producerId,
                                entityType: mutation.entityType,
                                revision: mutation.revision,
                                op: mutation.op,
                                ciphertext: mutation.ciphertext,
                                updatedSeq: seq,
                            },
                        });
                    }
                    await tx.sessionMutationV4.create({
                        data: {
                            sessionId,
                            mutationId: mutation.mutationId,
                            producerId: mutation.producerId,
                            entityId: mutation.entityId,
                            entityType: mutation.entityType,
                            revision: mutation.revision,
                            op: mutation.op,
                            ciphertext: mutation.ciphertext,
                            status: classification.status,
                            seq,
                        },
                    });
                    acknowledgements.push({
                        mutationId: mutation.mutationId,
                        seq,
                        revision: mutation.revision,
                        status: classification.status,
                    });
                }

                return {
                    acknowledgements,
                    highWatermark,
                    previousHighWatermark: highWatermark - newClassifications.length,
                    hasNewMutations: newClassifications.length > 0,
                };
            });

            if (result.hasNewMutations) {
                eventRouter.emitEphemeral({
                    userId: request.userId,
                    payload: { type: "sync-v4-invalidate", sessionId, highWatermark: result.highWatermark },
                    recipientFilter: { type: "all-interested-in-session", sessionId },
                });
                await pruneMutationJournal(
                    sessionId,
                    result.previousHighWatermark,
                    result.highWatermark,
                );
            }
            const metricLabels = getMetricsLabelsFromRequest(request);
            for (const acknowledgement of result.acknowledgements) {
                syncV4MutationResultsCounter.inc({ result: acknowledgement.status, ...metricLabels });
            }
            return reply.send({ acknowledgements: result.acknowledgements });
        } catch (error) {
            if (error instanceof RevisionConflictError) {
                syncV4MutationResultsCounter.inc({
                    result: "revision_conflict",
                    ...getMetricsLabelsFromRequest(request),
                });
                return reply.code(409).send({ error: "revisionConflict", ...error.details });
            }
            if (error instanceof MutationConflictError) {
                syncV4MutationResultsCounter.inc({
                    result: "mutation_conflict",
                    ...getMetricsLabelsFromRequest(request),
                });
                return reply.code(409).send({ error: "mutationConflict", mutationId: error.mutationId });
            }
            throw error;
        }
    });

    app.get("/v4/sessions/:sessionId/changes", {
        preHandler: [app.authenticate, requireCompatibleSyncV4Client],
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: changesQuerySchema,
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { after_seq: afterSeq, limit } = request.query;
        const session = await findOwnedSession(sessionId, request.userId);
        if (!session) return reply.code(404).send({ error: "Session not found" });

        const minimum = await db.sessionMutationV4.aggregate({
            where: { sessionId },
            _min: { seq: true },
        });
        const minimumSeq = minimum._min.seq;
        if (afterSeq > session.syncV4Seq) {
            return reply.code(400).send({ error: "Invalid changes cursor" });
        }
        const metricLabels = getMetricsLabelsFromRequest(request);
        syncV4ProjectionLagHistogram.observe(metricLabels, session.syncV4Seq - afterSeq);
        if (afterSeq < session.syncV4Seq && (minimumSeq === null || afterSeq < minimumSeq - 1)) {
            syncV4SnapshotFallbackCounter.inc({ reason: "journal_expired", ...metricLabels });
            return reply.code(410).send({
                error: "snapshotRequired",
                minimumSeq: minimumSeq ?? session.syncV4Seq + 1,
                highWatermark: session.syncV4Seq,
            });
        }

        const rows = await db.sessionMutationV4.findMany({
            where: { sessionId, seq: { gt: afterSeq, lte: session.syncV4Seq } },
            orderBy: { seq: "asc" },
            take: limit + 1,
        });
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        return reply.send({
            changes: page.map((row) => ({
                mutationId: row.mutationId,
                producerId: row.producerId,
                entityId: row.entityId,
                entityType: row.entityType,
                revision: row.revision,
                op: row.op,
                ciphertext: row.ciphertext,
                seq: row.seq,
                createdAt: row.createdAt.getTime(),
            })),
            hasMore,
            highWatermark: session.syncV4Seq,
        });
    });

    app.get("/v4/sessions/:sessionId/snapshot", {
        preHandler: [app.authenticate, requireCompatibleSyncV4Client],
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: snapshotQuerySchema,
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const session = await findOwnedSession(sessionId, request.userId);
        if (!session) return reply.code(404).send({ error: "Session not found" });
        const decodedCursor = decodeSnapshotCursor(request.query.cursor);
        if (request.query.cursor && !decodedCursor) {
            return reply.code(400).send({ error: "Invalid snapshot cursor" });
        }
        if (decodedCursor && decodedCursor.highWatermark > session.syncV4Seq) {
            return reply.code(400).send({ error: "Invalid snapshot cursor" });
        }
        const highWatermark = decodedCursor?.highWatermark ?? session.syncV4Seq;
        const rows = await db.sessionEntityV4.findMany({
            where: {
                sessionId,
                updatedSeq: { lte: highWatermark },
                ...(decodedCursor ? { entityId: { gt: decodedCursor.entityId } } : {}),
            },
            orderBy: { entityId: "asc" },
            take: request.query.limit + 1,
        });
        const hasMore = rows.length > request.query.limit;
        const page = hasMore ? rows.slice(0, request.query.limit) : rows;
        return reply.send({
            entities: page.map((row) => ({
                producerId: row.producerId,
                entityId: row.entityId,
                entityType: row.entityType,
                revision: row.revision,
                op: row.op,
                ciphertext: row.ciphertext,
                updatedSeq: row.updatedSeq,
                createdAt: row.createdAt.getTime(),
                updatedAt: row.updatedAt.getTime(),
            })),
            highWatermark,
            nextCursor: hasMore && page.length > 0
                ? encodeSnapshotCursor(highWatermark, page[page.length - 1].entityId)
                : null,
        });
    });
}
