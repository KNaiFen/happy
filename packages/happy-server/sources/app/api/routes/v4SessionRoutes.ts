import {
    classifySyncV4Mutations,
    MutationConflictError,
    RevisionConflictError,
    syncV4MutationContentHash,
} from "@/app/api/routes/syncV4MutationClassifier";
import { eventRouter } from "@/app/events/eventRouter";
import {
    getSyncV4MetricsLabelsFromRequest,
    syncV4MutationResultsCounter,
    syncV4OperationDurationHistogram,
    syncV4OperationsCounter,
    syncV4PageSizeHistogram,
    syncV4PrunedRecordsCounter,
    syncV4ProjectionLagHistogram,
    syncV4SnapshotFallbackCounter,
} from "@/app/monitoring/metrics2";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    classifySyncV4DiagnosticError,
    isSyncV4VersionAtLeast,
    MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH,
    MAX_SYNC_V4_CHANGES_PER_PAGE,
    MAX_SYNC_V4_CURSOR_LENGTH,
    MAX_SYNC_V4_DATABASE_INTEGER,
    MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH,
    MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE,
    SyncMutationBatchV4Schema,
    syncV4Utf8ByteLength,
} from "@slopus/happy-wire";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type Fastify } from "../types";
import {
    attachSyncV4Trace,
    completeServerSyncV4Request,
    logServerSyncV4Diagnostic,
    registerServerSyncV4Lifecycle,
    serverSyncV4DiagnosticHash,
} from "./syncV4Diagnostics";

const JOURNAL_MINIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const JOURNAL_MINIMUM_RECENT_RECORDS = 100_000;
const JOURNAL_CLEANUP_INTERVAL = 1_024;
const RESPONSE_FETCH_CHUNK_SIZE = 16;
const SYNC_V4_MUTATION_BODY_LIMIT = MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH + 1024 * 1024;
const MINIMUM_HAPPY_CLI_VERSION = "1.4.7";
const MINIMUM_HAPPY_APP_VERSION = "1.11.15";
const MINIMUM_CODEX_CLI_VERSION = "0.145.0";

type SyncV4MetricOperation =
    | "capabilities"
    | "mutations"
    | "changes"
    | "snapshot"
    | "invalidation"
    | "prune";

type SyncV4MetricOutcome =
    | "success"
    | "not_found"
    | "invalid"
    | "conflict"
    | "snapshot_required"
    | "error";

type SyncV4ClientCompatibility =
    | { compatible: true }
    | { compatible: false; clientType: "happy-cli" | "happy-app" | "unknown"; minimumVersion: string | null };

class SyncV4SessionReadOnlyError extends Error {
    constructor() {
        super("Sync v4 session is read-only");
        this.name = "SyncV4SessionReadOnlyError";
    }
}

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
    registerServerSyncV4Lifecycle(app, isCodexSyncV4Enabled());
    app.get("/v4/capabilities", {
        onRequest: [attachSyncV4Trace],
        onError: [syncV4RouteErrorHandler("capabilities")],
        onResponse: [syncV4RouteResponseHandler("capabilities")],
    }, async (request, reply) => {
        const startedAt = Date.now();
        const enabled = isCodexSyncV4Enabled();
        logServerSyncV4Diagnostic(request, {
            level: "debug",
            event: "transport",
            phase: "served",
            transportOperation: "capabilities",
            httpStatus: 200,
            durationMs: elapsedMs(startedAt),
            featureEnabled: enabled,
        });
        observeSyncV4Operation(request, "capabilities", "success", startedAt);
        return reply.send({
            codex: {
                enabled,
                protocolVersion: 4,
                minimumHappyCliVersion: MINIMUM_HAPPY_CLI_VERSION,
                minimumHappyAppVersion: MINIMUM_HAPPY_APP_VERSION,
                minimumCodexCliVersion: MINIMUM_CODEX_CLI_VERSION,
            },
        });
    });
}

const changesQuerySchema = z.object({
    after_seq: z.coerce.number().int().min(0).max(MAX_SYNC_V4_DATABASE_INTEGER).default(0),
    limit: z.coerce.number().int().min(1).max(MAX_SYNC_V4_CHANGES_PER_PAGE).default(100),
});

const snapshotQuerySchema = z.object({
    cursor: z.string().min(1).max(MAX_SYNC_V4_CURSOR_LENGTH).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE).default(100),
});

const sessionParamsSchema = z.object({
    sessionId: z.string().min(1).max(200),
});

function encodeSnapshotCursor(highWatermark: number, entityId: string): string {
    return `${highWatermark}:${entityId}`;
}

function decodeSnapshotCursor(cursor: string | undefined): { highWatermark: number; entityId: string } | null {
    if (!cursor) return null;
    const separator = cursor.indexOf(":");
    if (separator <= 0 || separator === cursor.length - 1) return null;
    const highWatermark = Number(cursor.slice(0, separator));
    if (
        !Number.isSafeInteger(highWatermark)
        || highWatermark < 0
        || highWatermark > MAX_SYNC_V4_DATABASE_INTEGER
    ) return null;
    return { highWatermark, entityId: cursor.slice(separator + 1) };
}

interface SyncV4SessionAccess {
    allowed: boolean;
    machineId?: string;
}

function authorizeSyncV4Session(
    request: FastifyRequest,
): SyncV4SessionAccess {
    const credentialId = request.authCredentialId;
    if (!credentialId) return { allowed: true };
    const machineIdHeader = request.headers["x-happy-machine-id"];
    if (
        typeof machineIdHeader !== "string"
        || machineIdHeader.length < 1
        || machineIdHeader.length > 200
    ) {
        return { allowed: false };
    }
    return request.authMachineId === machineIdHeader
        ? { allowed: true, machineId: machineIdHeader }
        : { allowed: false };
}

function sessionAccessWhere(
    request: FastifyRequest,
    sessionId: string,
    access: SyncV4SessionAccess,
) {
    return {
        id: sessionId,
        accountId: request.userId,
        ...(request.authCredentialId ? {
            originMachineId: access.machineId,
            originMachine: {
                is: {
                    credentialId: request.authCredentialId,
                    deletedAt: null,
                },
            },
        } : {}),
    };
}

async function findOwnedSession(
    store: Pick<typeof db, "session">,
    request: FastifyRequest,
    sessionId: string,
    access: SyncV4SessionAccess,
) {
    return store.session.findFirst({
        where: sessionAccessWhere(request, sessionId, access),
        select: {
            id: true,
            syncV4Seq: true,
            originMachineId: true,
            originMachine: {
                select: { deletedAt: true },
            },
        },
    });
}

interface CiphertextRow {
    ciphertext: string;
}

async function collectByteBoundedPage<Row extends CiphertextRow, Cursor>(
    limit: number,
    initialCursor: Cursor,
    fetchRows: (cursor: Cursor, take: number) => Promise<Row[]>,
    cursorOf: (row: Row) => Cursor,
): Promise<{ page: Row[]; hasMore: boolean }> {
    const page: Row[] = [];
    let cursor = initialCursor;
    let ciphertextBytes = 0;

    while (page.length < limit) {
        const remaining = limit - page.length;
        const take = Math.min(RESPONSE_FETCH_CHUNK_SIZE, remaining + 1);
        const rows = await fetchRows(cursor, take);
        if (rows.length === 0) return { page, hasMore: false };

        for (const row of rows) {
            if (page.length >= limit) return { page, hasMore: true };
            const rowBytes = syncV4Utf8ByteLength(row.ciphertext);
            if (rowBytes > MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH) {
                throw new Error("Sync v4 stored ciphertext exceeds response limit");
            }
            if (page.length > 0 && ciphertextBytes + rowBytes > MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH) {
                return { page, hasMore: true };
            }
            page.push(row);
            ciphertextBytes += rowBytes;
            cursor = cursorOf(row);
        }
        if (rows.length < take) return { page, hasMore: false };
    }

    return { page, hasMore: true };
}

/**
 * Removes journal rows only after both safety windows have elapsed. Current
 * entity snapshots remain available, while compact receipts preserve mutation
 * idempotency after the ciphertext journal payload expires.
 */
async function pruneMutationJournal(
    sessionId: string,
    previousHighWatermark: number,
    highWatermark: number,
): Promise<{ attempted: boolean; pruned: number }> {
    const previousCleanupBucket = Math.floor(previousHighWatermark / JOURNAL_CLEANUP_INTERVAL);
    const currentCleanupBucket = Math.floor(highWatermark / JOURNAL_CLEANUP_INTERVAL);
    if (currentCleanupBucket <= previousCleanupBucket) return { attempted: false, pruned: 0 };
    const maximumPrunableSeq = highWatermark - JOURNAL_MINIMUM_RECENT_RECORDS;
    if (maximumPrunableSeq <= 0) return { attempted: false, pruned: 0 };
    const result = await db.sessionMutationV4.updateMany({
        where: {
            sessionId,
            seq: { lte: maximumPrunableSeq },
            createdAt: { lt: new Date(Date.now() - JOURNAL_MINIMUM_AGE_MS) },
            prunedAt: null,
        },
        data: {
            ciphertext: "",
            prunedAt: new Date(),
        },
    });
    return { attempted: true, pruned: result.count };
}

function scheduleMutationJournalPrune(
    request: FastifyRequest,
    sessionId: string,
    sessionHash: string,
    previousHighWatermark: number,
    highWatermark: number,
): void {
    const pruneStartedAt = Date.now();
    void pruneMutationJournal(
        sessionId,
        previousHighWatermark,
        highWatermark,
    ).then((prune) => {
        if (!prune.attempted) return;
        logServerSyncV4Diagnostic(request, {
            level: "info",
            event: "prune",
            phase: "compacted",
            sessionHash,
            highWatermark,
            count: prune.pruned,
            durationMs: elapsedMs(pruneStartedAt),
        });
        observeSyncV4Operation(request, "prune", "success", pruneStartedAt);
        if (prune.pruned > 0) {
            syncV4PrunedRecordsCounter.inc(
                getSyncV4MetricsLabelsFromRequest(request),
                prune.pruned,
            );
        }
    }).catch((error) => {
        logServerSyncV4Diagnostic(request, {
            level: "warn",
            event: "prune",
            phase: "failed",
            sessionHash,
            highWatermark,
            durationMs: elapsedMs(pruneStartedAt),
            errorKind: classifySyncV4DiagnosticError(error),
        });
        observeSyncV4Operation(request, "prune", "error", pruneStartedAt);
    });
}

export function v4SessionRoutes(app: Fastify): void {
    app.post("/v4/sessions/:sessionId/mutations", {
        bodyLimit: SYNC_V4_MUTATION_BODY_LIMIT,
        onRequest: [attachSyncV4Trace, app.authenticate, requireCompatibleSyncV4Client],
        onError: [syncV4RouteErrorHandler("mutations")],
        onResponse: [syncV4RouteResponseHandler("mutations")],
        schema: {
            params: sessionParamsSchema,
            body: SyncMutationBatchV4Schema,
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const sessionHash = serverSyncV4DiagnosticHash(sessionId);
        const startedAt = Date.now();
        const requestMutationCount = request.body.mutations.length;
        const access = authorizeSyncV4Session(request);
        if (!access.allowed) {
            return reply.code(404).send({ error: "Session not found" });
        }
        logServerSyncV4Diagnostic(request, {
            level: "debug",
            event: "transport",
            phase: "received",
            transportOperation: "mutations",
            direction: "inbound",
            sessionHash,
            count: requestMutationCount,
            bytes: request.body.mutations.reduce(
                (total, mutation) => total + syncV4Utf8ByteLength(mutation.ciphertext),
                0,
            ),
        });

        try {
            const result = await inTx(async (tx) => {
                const session = await findOwnedSession(tx, request, sessionId, access);
                if (!session) return null;
                if (
                    !request.authCredentialId
                    && (
                        !session.originMachineId
                        || !session.originMachine
                        || session.originMachine.deletedAt !== null
                    )
                ) {
                    throw new SyncV4SessionReadOnlyError();
                }
                const mutations = request.body.mutations;
                const mutationIds = mutations.map((mutation) => mutation.mutationId);
                const entityIds = [...new Set(mutations.map((mutation) => mutation.entityId))];
                const existingMutations = await tx.sessionMutationV4.findMany({
                    where: { sessionId, mutationId: { in: mutationIds } },
                });
                const existingEntities = await tx.sessionEntityV4.findMany({
                    where: { sessionId, entityId: { in: entityIds } },
                });
                const mutationsById = new Map(existingMutations.map((mutation) => [mutation.mutationId, {
                    ...mutation,
                    contentHash: mutation.contentHash,
                }]));
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
                    if (session.syncV4Seq > MAX_SYNC_V4_DATABASE_INTEGER - newClassifications.length) {
                        throw new Error("Sync v4 sequence space exhausted");
                    }
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
                            contentHash: syncV4MutationContentHash(mutation),
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
            if (!result) {
                logServerSyncV4Diagnostic(request, {
                    level: "warn",
                    event: "transport",
                    phase: "failed",
                    transportOperation: "mutations",
                    sessionHash,
                    httpStatus: 404,
                    errorKind: "notFound",
                    count: requestMutationCount,
                    durationMs: elapsedMs(startedAt),
                });
                observeSyncV4Operation(
                    request,
                    "mutations",
                    "not_found",
                    startedAt,
                    requestMutationCount,
                );
                return reply.code(404).send({ error: "Session not found" });
            }

            if (result.hasNewMutations) {
                const invalidationStartedAt = Date.now();
                try {
                    eventRouter.emitEphemeral({
                        userId: request.userId,
                        payload: { type: "sync-v4-invalidate", sessionId, highWatermark: result.highWatermark },
                        recipientFilter: { type: "all-interested-in-session", sessionId },
                    });
                    logServerSyncV4Diagnostic(request, {
                        level: "debug",
                        event: "invalidation",
                        phase: "served",
                        transportOperation: "invalidation",
                        direction: "outbound",
                        sessionHash,
                        highWatermark: result.highWatermark,
                        durationMs: elapsedMs(invalidationStartedAt),
                    });
                    observeSyncV4Operation(
                        request,
                        "invalidation",
                        "success",
                        invalidationStartedAt,
                    );
                } catch (error) {
                    logServerSyncV4Diagnostic(request, {
                        level: "warn",
                        event: "invalidation",
                        phase: "failed",
                        transportOperation: "invalidation",
                        direction: "outbound",
                        sessionHash,
                        highWatermark: result.highWatermark,
                        durationMs: elapsedMs(invalidationStartedAt),
                        errorKind: classifySyncV4DiagnosticError(error),
                    });
                    observeSyncV4Operation(
                        request,
                        "invalidation",
                        "error",
                        invalidationStartedAt,
                    );
                }

                scheduleMutationJournalPrune(
                    request,
                    sessionId,
                    sessionHash,
                    result.previousHighWatermark,
                    result.highWatermark,
                );
            }
            const metricLabels = getSyncV4MetricsLabelsFromRequest(request);
            let accepted = 0;
            let duplicate = 0;
            let superseded = 0;
            for (const acknowledgement of result.acknowledgements) {
                syncV4MutationResultsCounter.inc({ result: acknowledgement.status, ...metricLabels });
                if (acknowledgement.status === "accepted") accepted += 1;
                if (acknowledgement.status === "duplicate") duplicate += 1;
                if (acknowledgement.status === "superseded") superseded += 1;
            }
            logServerSyncV4Diagnostic(request, {
                level: "debug",
                event: "ack",
                phase: "acknowledged",
                transportOperation: "mutations",
                direction: "outbound",
                sessionHash,
                httpStatus: 200,
                highWatermark: result.highWatermark,
                count: result.acknowledgements.length,
                accepted,
                duplicate,
                superseded,
                durationMs: elapsedMs(startedAt),
            });
            observeSyncV4Operation(
                request,
                "mutations",
                "success",
                startedAt,
                requestMutationCount,
            );
            return reply.send({ acknowledgements: result.acknowledgements });
        } catch (error) {
            if (error instanceof SyncV4SessionReadOnlyError) {
                syncV4MutationResultsCounter.inc({
                    result: "session_read_only",
                    ...getSyncV4MetricsLabelsFromRequest(request),
                });
                logServerSyncV4Diagnostic(request, {
                    level: "warn",
                    event: "ack",
                    phase: "failed",
                    transportOperation: "mutations",
                    sessionHash,
                    httpStatus: 409,
                    errorKind: "conflict",
                    count: requestMutationCount,
                    durationMs: elapsedMs(startedAt),
                });
                observeSyncV4Operation(
                    request,
                    "mutations",
                    "conflict",
                    startedAt,
                    requestMutationCount,
                );
                return reply.code(409).send({ error: "sessionReadOnly" });
            }
            if (error instanceof RevisionConflictError) {
                syncV4MutationResultsCounter.inc({
                    result: "revision_conflict",
                    ...getSyncV4MetricsLabelsFromRequest(request),
                });
                logServerSyncV4Diagnostic(request, {
                    level: "warn",
                    event: "ack",
                    phase: "failed",
                    transportOperation: "mutations",
                    sessionHash,
                    httpStatus: 409,
                    errorKind: "conflict",
                    count: requestMutationCount,
                    durationMs: elapsedMs(startedAt),
                });
                observeSyncV4Operation(
                    request,
                    "mutations",
                    "conflict",
                    startedAt,
                    requestMutationCount,
                );
                return reply.code(409).send({ error: "revisionConflict", ...error.details });
            }
            if (error instanceof MutationConflictError) {
                syncV4MutationResultsCounter.inc({
                    result: "mutation_conflict",
                    ...getSyncV4MetricsLabelsFromRequest(request),
                });
                logServerSyncV4Diagnostic(request, {
                    level: "warn",
                    event: "ack",
                    phase: "failed",
                    transportOperation: "mutations",
                    sessionHash,
                    httpStatus: 409,
                    errorKind: "conflict",
                    count: requestMutationCount,
                    durationMs: elapsedMs(startedAt),
                });
                observeSyncV4Operation(
                    request,
                    "mutations",
                    "conflict",
                    startedAt,
                    requestMutationCount,
                );
                return reply.code(409).send({ error: "mutationConflict", mutationId: error.mutationId });
            }
            logServerSyncV4Diagnostic(request, {
                level: "error",
                event: "transport",
                phase: "failed",
                transportOperation: "mutations",
                sessionHash,
                errorKind: classifySyncV4DiagnosticError(error),
                count: requestMutationCount,
                durationMs: elapsedMs(startedAt),
            });
            observeSyncV4Operation(
                request,
                "mutations",
                "error",
                startedAt,
                requestMutationCount,
            );
            throw error;
        }
    });

    app.get("/v4/sessions/:sessionId/changes", {
        onRequest: [attachSyncV4Trace, app.authenticate, requireCompatibleSyncV4Client],
        onError: [syncV4RouteErrorHandler("changes")],
        onResponse: [syncV4RouteResponseHandler("changes")],
        schema: {
            params: sessionParamsSchema,
            querystring: changesQuerySchema,
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { after_seq: afterSeq, limit } = request.query;
        const sessionHash = serverSyncV4DiagnosticHash(sessionId);
        const startedAt = Date.now();
        const access = authorizeSyncV4Session(request);
        if (!access.allowed) {
            return reply.code(404).send({ error: "Session not found" });
        }
        const result = await inTx(async (tx) => {
            const session = await findOwnedSession(tx, request, sessionId, access);
            if (!session) return { kind: "notFound" as const };
            const minimum = await tx.sessionMutationV4.aggregate({
                where: { sessionId, prunedAt: null },
                _min: { seq: true },
            });
            const minimumSeq = minimum._min.seq;
            if (afterSeq > session.syncV4Seq) {
                return { kind: "invalid" as const };
            }
            if (afterSeq < session.syncV4Seq && (minimumSeq === null || afterSeq < minimumSeq - 1)) {
                return {
                    kind: "snapshotRequired" as const,
                    reason: "journal_expired" as const,
                    minimumSeq: minimumSeq ?? session.syncV4Seq + 1,
                    highWatermark: session.syncV4Seq,
                };
            }
            const { page, hasMore } = await collectByteBoundedPage(
                limit,
                afterSeq,
                (cursor, take) => tx.sessionMutationV4.findMany({
                    where: {
                        sessionId,
                        prunedAt: null,
                        seq: { gt: cursor, lte: session.syncV4Seq },
                    },
                    orderBy: { seq: "asc" },
                    take,
                }),
                (row) => row.seq,
            );
            const firstGapIndex = page.findIndex((row, index) => row.seq !== afterSeq + index + 1);
            if (firstGapIndex >= 0) {
                return {
                    kind: "snapshotRequired" as const,
                    reason: "journal_gap" as const,
                    minimumSeq: page[firstGapIndex].seq,
                    highWatermark: session.syncV4Seq,
                };
            }
            return {
                kind: "ok" as const,
                page,
                hasMore,
                highWatermark: session.syncV4Seq,
            };
        });
        if (result.kind === "notFound") {
            logServerSyncV4Diagnostic(request, {
                level: "warn",
                event: "changes",
                phase: "failed",
                transportOperation: "changes",
                sessionHash,
                cursor: afterSeq,
                httpStatus: 404,
                errorKind: "notFound",
                durationMs: elapsedMs(startedAt),
            });
            observeSyncV4Operation(request, "changes", "not_found", startedAt, 0);
            return reply.code(404).send({ error: "Session not found" });
        }
        if (result.kind === "invalid") {
            logServerSyncV4Diagnostic(request, {
                level: "warn",
                event: "changes",
                phase: "failed",
                transportOperation: "changes",
                sessionHash,
                cursor: afterSeq,
                httpStatus: 400,
                errorKind: "validation",
                durationMs: elapsedMs(startedAt),
            });
            observeSyncV4Operation(request, "changes", "invalid", startedAt, 0);
            return reply.code(400).send({ error: "Invalid changes cursor" });
        }
        const metricLabels = getSyncV4MetricsLabelsFromRequest(request);
        syncV4ProjectionLagHistogram.observe(metricLabels, result.highWatermark - afterSeq);
        if (result.kind === "snapshotRequired") {
            syncV4SnapshotFallbackCounter.inc({ reason: result.reason, ...metricLabels });
            logServerSyncV4Diagnostic(request, {
                level: "warn",
                event: "snapshot",
                phase: "required",
                transportOperation: "changes",
                sessionHash,
                cursor: afterSeq,
                seq: result.minimumSeq,
                highWatermark: result.highWatermark,
                reason: result.reason === "journal_expired" ? "journalExpired" : "journalGap",
                httpStatus: 410,
                durationMs: elapsedMs(startedAt),
            });
            observeSyncV4Operation(
                request,
                "changes",
                "snapshot_required",
                startedAt,
                0,
            );
            return reply.code(410).send({
                error: "snapshotRequired",
                minimumSeq: result.minimumSeq,
                highWatermark: result.highWatermark,
            });
        }

        logServerSyncV4Diagnostic(request, {
            level: "debug",
            event: "changes",
            phase: "served",
            transportOperation: "changes",
            direction: "outbound",
            sessionHash,
            cursor: afterSeq,
            highWatermark: result.highWatermark,
            count: result.page.length,
            httpStatus: 200,
            durationMs: elapsedMs(startedAt),
        });
        observeSyncV4Operation(
            request,
            "changes",
            "success",
            startedAt,
            result.page.length,
        );
        return reply.send({
            changes: result.page.map((row) => ({
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
            hasMore: result.hasMore,
            highWatermark: result.highWatermark,
        });
    });

    app.get("/v4/sessions/:sessionId/snapshot", {
        onRequest: [attachSyncV4Trace, app.authenticate, requireCompatibleSyncV4Client],
        onError: [syncV4RouteErrorHandler("snapshot")],
        onResponse: [syncV4RouteResponseHandler("snapshot")],
        schema: {
            params: sessionParamsSchema,
            querystring: snapshotQuerySchema,
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const sessionHash = serverSyncV4DiagnosticHash(sessionId);
        const startedAt = Date.now();
        const access = authorizeSyncV4Session(request);
        if (!access.allowed) {
            return reply.code(404).send({ error: "Session not found" });
        }
        const session = await findOwnedSession(db, request, sessionId, access);
        if (!session) {
            logServerSyncV4Diagnostic(request, {
                level: "warn",
                event: "snapshot",
                phase: "failed",
                transportOperation: "snapshot",
                sessionHash,
                httpStatus: 404,
                errorKind: "notFound",
                durationMs: elapsedMs(startedAt),
            });
            observeSyncV4Operation(request, "snapshot", "not_found", startedAt, 0);
            return reply.code(404).send({ error: "Session not found" });
        }
        const decodedCursor = decodeSnapshotCursor(request.query.cursor);
        if (request.query.cursor && !decodedCursor) {
            logServerSyncV4Diagnostic(request, {
                level: "warn",
                event: "snapshot",
                phase: "failed",
                transportOperation: "snapshot",
                sessionHash,
                httpStatus: 400,
                errorKind: "validation",
                durationMs: elapsedMs(startedAt),
            });
            observeSyncV4Operation(request, "snapshot", "invalid", startedAt, 0);
            return reply.code(400).send({ error: "Invalid snapshot cursor" });
        }
        if (decodedCursor && decodedCursor.highWatermark > session.syncV4Seq) {
            logServerSyncV4Diagnostic(request, {
                level: "warn",
                event: "snapshot",
                phase: "failed",
                transportOperation: "snapshot",
                sessionHash,
                highWatermark: decodedCursor.highWatermark,
                httpStatus: 400,
                errorKind: "validation",
                durationMs: elapsedMs(startedAt),
            });
            observeSyncV4Operation(request, "snapshot", "invalid", startedAt, 0);
            return reply.code(400).send({ error: "Invalid snapshot cursor" });
        }
        const highWatermark = decodedCursor?.highWatermark ?? session.syncV4Seq;
        const { page, hasMore } = await collectByteBoundedPage(
            request.query.limit,
            decodedCursor?.entityId ?? "",
            (cursor, take) => db.sessionEntityV4.findMany({
                where: {
                    sessionId,
                    updatedSeq: { lte: highWatermark },
                    ...(cursor ? { entityId: { gt: cursor } } : {}),
                },
                orderBy: { entityId: "asc" },
                take,
            }),
            (row) => row.entityId,
        );
        logServerSyncV4Diagnostic(request, {
            level: "debug",
            event: "snapshot",
            phase: "served",
            transportOperation: "snapshot",
            direction: "outbound",
            sessionHash,
            highWatermark,
            count: page.length,
            httpStatus: 200,
            durationMs: elapsedMs(startedAt),
        });
        observeSyncV4Operation(
            request,
            "snapshot",
            "success",
            startedAt,
            page.length,
        );
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

function observeSyncV4Operation(
    request: FastifyRequest,
    operation: SyncV4MetricOperation,
    outcome: SyncV4MetricOutcome,
    startedAt: number,
    pageSize?: number,
): void {
    if (
        operation === "capabilities"
        || operation === "mutations"
        || operation === "changes"
        || operation === "snapshot"
    ) {
        request.syncV4RouteOutcomeObserved = true;
        completeServerSyncV4Request(request);
    }
    const clientLabels = getSyncV4MetricsLabelsFromRequest(request);
    const labels = { operation, outcome, ...clientLabels };
    syncV4OperationsCounter.inc(labels);
    syncV4OperationDurationHistogram.observe(labels, elapsedMs(startedAt) / 1_000);
    if (
        pageSize !== undefined
        && (operation === "mutations" || operation === "changes" || operation === "snapshot")
    ) {
        syncV4PageSizeHistogram.observe(
            { operation, ...clientLabels },
            pageSize,
        );
    }
}

function elapsedMs(startedAt: number): number {
    return Math.max(0, Math.trunc(Date.now() - startedAt));
}

function syncV4RouteErrorHandler(
    operation: "capabilities" | "mutations" | "changes" | "snapshot",
) {
    return async (
        request: FastifyRequest,
        reply: FastifyReply,
        error: Error,
    ): Promise<void> => {
        if (request.syncV4RouteOutcomeObserved) return;
        const startedAt = request.startTime ?? Date.now();
        const status = syncV4ErrorStatus(error, reply.statusCode);
        const sessionId = syncV4RequestSessionId(request);
        const classifiedError = classifySyncV4DiagnosticError(error);
        const event = operation === "changes" || operation === "snapshot"
            ? operation
            : "transport";
        logServerSyncV4Diagnostic(request, {
            level: "error",
            event,
            phase: "failed",
            transportOperation: operation,
            sessionHash: sessionId
                ? serverSyncV4DiagnosticHash(sessionId)
                : undefined,
            httpStatus: status,
            errorKind: classifiedError === "unknown"
                ? classifySyncV4DiagnosticError({ statusCode: status })
                : classifiedError,
            durationMs: elapsedMs(startedAt),
        });
        observeSyncV4Operation(
            request,
            operation,
            syncV4MetricOutcomeForStatus(status),
            startedAt,
        );
    };
}

function syncV4RouteResponseHandler(
    operation: "capabilities" | "mutations" | "changes" | "snapshot",
) {
    return async (
        request: FastifyRequest,
        reply: FastifyReply,
    ): Promise<void> => {
        if (request.syncV4RouteOutcomeObserved) return;
        if (reply.statusCode < 400) {
            completeServerSyncV4Request(request);
            return;
        }
        const startedAt = request.startTime ?? Date.now();
        const sessionId = syncV4RequestSessionId(request);
        const event = operation === "changes" || operation === "snapshot"
            ? operation
            : "transport";
        logServerSyncV4Diagnostic(request, {
            level: reply.statusCode >= 500 ? "error" : "warn",
            event,
            phase: "failed",
            transportOperation: operation,
            sessionHash: sessionId
                ? serverSyncV4DiagnosticHash(sessionId)
                : undefined,
            httpStatus: reply.statusCode,
            errorKind: classifySyncV4DiagnosticError({
                statusCode: reply.statusCode,
            }),
            durationMs: elapsedMs(startedAt),
        });
        observeSyncV4Operation(
            request,
            operation,
            syncV4MetricOutcomeForStatus(reply.statusCode),
            startedAt,
        );
    };
}

function syncV4RequestSessionId(request: FastifyRequest): string | null {
    return (
        request.params
        && typeof request.params === "object"
        && "sessionId" in request.params
        && typeof request.params.sessionId === "string"
    ) ? request.params.sessionId : null;
}

export function syncV4ErrorStatus(error: unknown, replyStatus: number): number {
    let statusCode: unknown;
    try {
        statusCode = error && (typeof error === "object" || typeof error === "function")
            ? (error as { statusCode?: unknown }).statusCode
            : undefined;
    } catch {
        statusCode = undefined;
    }
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599) {
        return statusCode;
    }
    return replyStatus >= 400 && replyStatus <= 599 ? replyStatus : 500;
}

function syncV4MetricOutcomeForStatus(status: number): SyncV4MetricOutcome {
    if (status === 404) return "not_found";
    if (status === 409) return "conflict";
    if (status >= 400 && status < 500) return "invalid";
    return "error";
}
