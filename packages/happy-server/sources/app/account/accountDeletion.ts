import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import * as privacyKit from 'privacy-kit';
import { auth } from '@/app/auth/auth';
import {
    buildRelationshipUpdatedEvent,
    eventRouter,
} from '@/app/events/eventRouter';
import { activityCache } from '@/app/presence/sessionCache';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { allocateUserSeq } from '@/storage/seq';
import {
    deleteAccountFiles,
    deleteSessionAttachments,
    deleteFile,
    forEachSessionAttachmentId,
    isLocalStorage,
    probeFile,
} from '@/storage/files';
import { diagnosticHash } from '@/utils/diagnosticHash';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { onShutdown } from '@/utils/shutdown';
import { log } from '@/utils/log';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;
const LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_MS = 60 * 1000;
// Older Server versions handed S3 upload URLs directly to clients for 15
// minutes. Keep a confirmed deletion pending long enough to sweep a late write
// from one of those capabilities before its Account row is removed.
const LEGACY_PRESIGNED_URL_GRACE_MS = 16 * 60 * 1000;
const ORPHAN_ATTACHMENT_SWEEP_LOCK_KEY = 'account-deletion-orphan-attachment-sweep';
const ORPHAN_ATTACHMENT_SWEEP_LEASE_MS = 60 * 60 * 1000;
const ORPHAN_ATTACHMENT_SWEEP_COOLDOWN_MS = 15 * 60 * 1000;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

let retryTimer: ReturnType<typeof setInterval> | null = null;
const locallyProcessingAccounts = new Set<string>();

export type AccountDeletionOutcome = 'deleted' | 'pending';

export class AccountDeletionError extends Error {
    constructor(
        public readonly code:
            | 'invalid-proof'
            | 'expired-challenge'
            | 'deletion-in-progress'
            | 'legacy-upload-capability-cutoff-unconfirmed',
    ) {
        super(code);
    }
}

export async function createAccountDeletionChallenge(accountId: string): Promise<{
    challengeId: string;
    challenge: string;
    expiresAt: number;
}> {
    // S3 deployments that ever served direct upload capabilities need an
    // operator-confirmed drain time before deletion can safely finish. Refuse
    // to consume a proof until that safety boundary is known.
    getInitialFinalSweepAfter(new Date());
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: { deletionRequestedAt: true },
    });
    if (!account || account.deletionRequestedAt !== null) {
        throw new AccountDeletionError('deletion-in-progress');
    }

    const challenge = randomBytes(32);
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    await db.accountDeletionChallenge.deleteMany({
        where: { accountId },
    });
    const record = await db.accountDeletionChallenge.create({
        data: {
            accountId,
            challengeHash: hashChallenge(challenge),
            expiresAt,
        },
        select: { id: true },
    });

    return {
        challengeId: record.id,
        challenge: challenge.toString('base64'),
        expiresAt: expiresAt.getTime(),
    };
}

export async function confirmAccountDeletion(input: {
    accountId: string;
    challengeId: string;
    challenge: string;
    publicKey: string;
    signature: string;
}): Promise<AccountDeletionOutcome> {
    const finalSweepAfter = getInitialFinalSweepAfter(new Date());
    const proof = await loadDeletionProof(input.accountId, input.challengeId);
    if (!proof) {
        throw new AccountDeletionError('expired-challenge');
    }

    const decoded = decodeDeletionProof(input);
    if (!decoded || !matchesChallenge(decoded.challenge, proof.challengeHash)) {
        throw new AccountDeletionError('invalid-proof');
    }
    if (privacyKit.encodeHex(decoded.publicKey) !== proof.publicKey) {
        throw new AccountDeletionError('invalid-proof');
    }

    const tweetnacl = (await import('tweetnacl')).default;
    if (!tweetnacl.sign.detached.verify(decoded.challenge, decoded.signature, decoded.publicKey)) {
        throw new AccountDeletionError('invalid-proof');
    }

    const now = new Date();
    const accepted = await inTx((tx) => acceptAccountDeletionProofInTransaction(tx, {
        accountId: input.accountId,
        challengeId: input.challengeId,
        now,
        finalSweepAfter,
    }));
    if (!accepted) {
        throw new AccountDeletionError('expired-challenge');
    }

    auth.invalidateUserTokens(input.accountId);
    activityCache.invalidateUser(input.accountId);
    eventRouter.disconnectUser(input.accountId);

    return processAccountDeletion(input.accountId);
}

export async function acceptAccountDeletionProofInTransaction(
    tx: Tx,
    input: {
        accountId: string;
        challengeId: string;
        now: Date;
        finalSweepAfter: Date;
    },
): Promise<boolean> {
    const consumed = await tx.accountDeletionChallenge.updateMany({
        where: {
            id: input.challengeId,
            accountId: input.accountId,
            consumedAt: null,
            expiresAt: { gt: input.now },
        },
        data: { consumedAt: input.now },
    });
    if (consumed.count !== 1) return false;

    const locked = await tx.account.updateMany({
        where: {
            id: input.accountId,
            deletionRequestedAt: null,
        },
        data: { deletionRequestedAt: input.now },
    });
    if (locked.count !== 1) {
        throw new AccountDeletionError('deletion-in-progress');
    }

    await tx.accountDeletionRequest.upsert({
        where: { accountId: input.accountId },
        create: {
            accountId: input.accountId,
            finalSweepAfter: input.finalSweepAfter,
        },
        update: {},
    });
    return true;
}

export function startAccountDeletionProcessor(): void {
    if (retryTimer) return;
    retryTimer = setInterval(() => {
        void processPendingAccountDeletions();
    }, RETRY_INTERVAL_MS);
    onShutdown('account-deletion', async () => {
        if (retryTimer) {
            clearInterval(retryTimer);
            retryTimer = null;
        }
    });
    void processPendingAccountDeletions();
}

export async function processAccountDeletion(accountId: string): Promise<AccountDeletionOutcome> {
    if (locallyProcessingAccounts.has(accountId)) {
        return 'pending';
    }
    locallyProcessingAccounts.add(accountId);
    let lease: DeletionLease | null = null;
    try {
        lease = await claimDeletionLease(accountId);
        if (!lease) {
            return 'pending';
        }

        const result = await withDeletionLeaseHeartbeat(
            accountId,
            lease,
            (assertLease) => eraseAccountData(accountId, lease!, assertLease),
        );
        if (result.status === 'deleted') {
            await notifyRelationshipPeers(accountId, result.relationshipPeerIds);
            log({
                module: 'account-deletion',
                userHash: diagnosticHash(accountId),
                outcome: 'deleted',
            }, 'Account data deletion completed');
            return 'deleted';
        }

        await releaseDeletionLease(accountId, lease);
        return 'pending';
    } catch {
        if (lease) {
            await releaseDeletionLease(accountId, lease);
        }
        log({
            module: 'account-deletion',
            level: 'error',
            userHash: diagnosticHash(accountId),
            outcome: 'pending',
        }, 'Account data deletion will retry');
        return 'pending';
    } finally {
        locallyProcessingAccounts.delete(accountId);
    }
}

async function processPendingAccountDeletions(): Promise<void> {
    try {
        try {
            await db.accountDeletionUploadOperation.deleteMany({
                where: { completedAt: { not: null } },
            });
        } catch {
            // Completed rows never block deletion. Keep scanning accounts when
            // best-effort bookkeeping cleanup is temporarily unavailable.
        }
        try {
            await cleanupInactiveGithubOAuthAdmissions();
        } catch {
            // Completed and unclaimed expired rows never block deletion.
        }
        const now = new Date();
        const eligibleWhere = {
            where: {
                OR: [
                    { leaseExpiresAt: null },
                    { leaseExpiresAt: { lt: now } },
                ],
            },
        };
        // Prefer requests that have never been attempted. PostgreSQL's default
        // NULL ordering is not suitable here, so this is deliberately two
        // queries rather than relying on an implicit database ordering.
        const unattempted = await db.accountDeletionRequest.findMany({
            ...eligibleWhere,
            where: {
                ...eligibleWhere.where,
                lastAttemptedAt: null,
            },
            select: { accountId: true },
            orderBy: { requestedAt: 'asc' },
            take: 100,
        });
        const requests = unattempted.length === 100
            ? unattempted
            : [
                ...unattempted,
                ...(await db.accountDeletionRequest.findMany({
                    ...eligibleWhere,
                    where: {
                        ...eligibleWhere.where,
                        lastAttemptedAt: { not: null },
                    },
                    select: { accountId: true },
                    orderBy: { lastAttemptedAt: 'asc' },
                    take: 100 - unattempted.length,
                })),
            ];
        for (const request of requests) {
            await processAccountDeletion(request.accountId);
        }
    } catch {
        log({
            module: 'account-deletion',
            level: 'error',
        }, 'Account deletion retry scan failed');
    }
}

/**
 * Begin an upload operation while the account is still writable. Updating the
 * Account row and creating this record occur in one transaction, so a
 * concurrent delete either sees the operation or prevents its creation.
 *
 * The operation deliberately has no expiry. A storage write that has reached
 * the object service can outlive an HTTP timeout, so deleting on a timer could
 * leave a late object behind after the final sweep.
 */
export async function beginAccountDeletionUpload(accountId: string, objectKey: string): Promise<string | null> {
    const now = new Date();
    return inTx(async (tx) => {
        const writable = await tx.account.updateMany({
            where: {
                id: accountId,
                deletionRequestedAt: null,
            },
            data: { updatedAt: now },
        });
        if (writable.count !== 1) return null;
        const operation = await tx.accountDeletionUploadOperation.create({
            data: { accountId, objectKey },
            select: { id: true },
        });
        return operation.id;
    });
}

/** Mark an upload operation complete after the underlying object-store write succeeds. */
export async function settleAccountDeletionUpload(operationId: string): Promise<void> {
    const completed = await db.accountDeletionUploadOperation.updateMany({
        where: { id: operationId, completedAt: null },
        data: { completedAt: new Date() },
    });
    if (completed.count !== 1) {
        throw new Error('Failed to persist upload completion');
    }
    try {
        await db.accountDeletionUploadOperation.deleteMany({ where: { id: operationId } });
    } catch {
        // Completion is durable; a retry scan will remove this bookkeeping row.
    }
}

function getInitialFinalSweepAfter(now: Date): Date {
    if (isLocalStorage()) {
        return now;
    }

    const rawCutoff = process.env.ACCOUNT_DELETION_LEGACY_DIRECT_UPLOADS_DRAINED_AT;
    const cutoffMs = parseStrictIsoUtcTimestamp(rawCutoff);
    // A future cutoff would allow a configuration typo to make an account look
    // deleted before the last old capability can have expired.
    if (!Number.isFinite(cutoffMs) || cutoffMs > now.getTime()) {
        throw new AccountDeletionError('legacy-upload-capability-cutoff-unconfirmed');
    }
    return new Date(cutoffMs + LEGACY_PRESIGNED_URL_GRACE_MS);
}

function parseStrictIsoUtcTimestamp(raw: string | undefined): number {
    if (!raw || !ISO_UTC_TIMESTAMP.test(raw)) return Number.NaN;

    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) return Number.NaN;

    const canonical = raw.includes('.') ? raw : raw.replace('Z', '.000Z');
    return new Date(timestamp).toISOString() === canonical
        ? timestamp
        : Number.NaN;
}

async function loadDeletionProof(accountId: string, challengeId: string): Promise<{
    challengeHash: string;
    publicKey: string;
} | null> {
    const challenge = await db.accountDeletionChallenge.findFirst({
        where: {
            id: challengeId,
            accountId,
            consumedAt: null,
            expiresAt: { gt: new Date() },
            account: { deletionRequestedAt: null },
        },
        select: {
            challengeHash: true,
            account: { select: { publicKey: true } },
        },
    });
    if (!challenge?.account) return null;
    return {
        challengeHash: challenge.challengeHash,
        publicKey: challenge.account.publicKey,
    };
}

function decodeDeletionProof(input: {
    challenge: string;
    publicKey: string;
    signature: string;
}): {
    challenge: privacyKit.Bytes;
    publicKey: privacyKit.Bytes;
    signature: privacyKit.Bytes;
} | null {
    try {
        const challenge = privacyKit.decodeBase64(input.challenge);
        const publicKey = privacyKit.decodeBase64(input.publicKey);
        const signature = privacyKit.decodeBase64(input.signature);
        if (challenge.length !== 32 || publicKey.length !== 32 || signature.length !== 64) {
            return null;
        }
        return { challenge, publicKey, signature };
    } catch {
        return null;
    }
}

function hashChallenge(challenge: Uint8Array): string {
    return createHash('sha256').update(challenge).digest('hex');
}

function matchesChallenge(challenge: Uint8Array, expectedHash: string): boolean {
    const actual = Buffer.from(hashChallenge(challenge), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

type DeletionLease = {
    token: string;
    finalSweepAfter: Date;
    requestedAt: Date;
    expiresAt: Date;
};

class DeletionLeaseLostError extends Error {
    constructor() {
        super('account deletion lease lost');
    }
}

async function claimDeletionLease(accountId: string): Promise<DeletionLease | null> {
    const request = await db.accountDeletionRequest.findUnique({
        where: { accountId },
        select: { finalSweepAfter: true, requestedAt: true },
    });
    if (!request) return null;
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_MS);
    const leaseToken = randomBytes(16).toString('hex');
    const claimed = await db.accountDeletionRequest.updateMany({
        where: {
            accountId,
            OR: [
                { leaseExpiresAt: null },
                { leaseExpiresAt: { lt: now } },
            ],
        },
        data: {
            leaseExpiresAt,
            leaseToken,
            lastAttemptedAt: now,
        },
    });
    return claimed.count === 1
        ? {
            token: leaseToken,
            finalSweepAfter: request.finalSweepAfter,
            requestedAt: request.requestedAt,
            expiresAt: leaseExpiresAt,
        }
        : null;
}

async function renewDeletionLease(accountId: string, lease: DeletionLease): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
    const renewed = await db.accountDeletionRequest.updateMany({
        where: {
            accountId,
            leaseToken: lease.token,
            leaseExpiresAt: { gt: now },
        },
        data: { leaseExpiresAt: expiresAt },
    });
    if (renewed.count !== 1) throw new DeletionLeaseLostError();
    lease.expiresAt = expiresAt;
}

async function assertDeletionLease(accountId: string, lease: DeletionLease): Promise<void> {
    const request = await db.accountDeletionRequest.findUnique({
        where: { accountId },
        select: { leaseToken: true, leaseExpiresAt: true },
    });
    if (
        request?.leaseToken !== lease.token
        || !request.leaseExpiresAt
        || request.leaseExpiresAt <= new Date()
    ) {
        throw new DeletionLeaseLostError();
    }
}

async function withDeletionLeaseHeartbeat<T>(
    accountId: string,
    lease: DeletionLease,
    operation: (assertLease: () => Promise<void>) => Promise<T>,
): Promise<T> {
    let leaseLost = false;
    const heartbeat = setInterval(() => {
        void renewDeletionLease(accountId, lease).catch(() => {
            leaseLost = true;
        });
    }, LEASE_HEARTBEAT_MS);
    const assertLease = async () => {
        if (leaseLost) throw new DeletionLeaseLostError();
        await assertDeletionLease(accountId, lease);
        if (leaseLost) throw new DeletionLeaseLostError();
    };
    try {
        await assertLease();
        return await operation(assertLease);
    } finally {
        clearInterval(heartbeat);
    }
}

async function releaseDeletionLease(accountId: string, lease: DeletionLease): Promise<void> {
    try {
        await db.accountDeletionRequest.updateMany({
            where: {
                accountId,
                leaseToken: lease.token,
            },
            data: { leaseExpiresAt: null, leaseToken: null },
        });
    } catch {
        // A later retry will reclaim an expired lease. Do not expose storage errors in logs.
    }
}

async function eraseAccountData(
    accountId: string,
    lease: DeletionLease,
    assertLease: () => Promise<void>,
): Promise<
    | { status: 'deleted'; relationshipPeerIds: string[] }
    | { status: 'pending' }
> {
    // Do not enumerate account prefixes until every write admitted before the
    // deletion lock has reported confirmed success. Once this gate has
    // passed, no new upload operation can be created and this is the sole
    // final object sweep.
    if (Date.now() < lease.finalSweepAfter.getTime()) {
        return { status: 'pending' };
    }
    await reconcilePendingAccountDeletionUploads(accountId, assertLease);
    if (await hasPendingAccountDeletionUploads(accountId)) {
        return { status: 'pending' };
    }
    if (await hasActiveVoiceCredentialAdmissions(accountId)) {
        return { status: 'pending' };
    }
    if (await hasClaimedGithubOAuthAdmission(accountId)) {
        return { status: 'pending' };
    }

    await assertLease();

    const sessions = await db.session.findMany({
        where: { accountId },
        select: { id: true },
    });
    const cleanedSessionIds = new Set(sessions.map((session) => session.id));
    await deleteAccountFiles(accountId, [...cleanedSessionIds]);
    await assertLease();

    if (!(await ensureOrphanedSessionAttachmentsCleanedAfter(lease.requestedAt))) {
        return { status: 'pending' };
    }

    // The orphan sweep can outlast this worker's lease. Re-check immediately
    // before the serializable final transaction, then fence that transaction
    // on both token ownership and an unexpired lease.
    await assertLease();

    return inTx(async (tx) => {
        const now = new Date();
        const leaseStillOwned = await tx.accountDeletionRequest.updateMany({
            where: {
                accountId,
                leaseToken: lease.token,
                leaseExpiresAt: { gt: now },
            },
            data: { lastAttemptedAt: now },
        });
        if (leaseStillOwned.count !== 1) {
            return { status: 'pending' as const };
        }
        // Lock the marked Account row before observing its related data. This
        // serializes the final sweep with in-flight profile/GitHub mutations.
        const locked = await tx.account.updateMany({
            where: {
                id: accountId,
                deletionRequestedAt: { not: null },
            },
            data: { updatedAt: new Date() },
        });
        if (locked.count !== 1) {
            const existing = await tx.account.findUnique({
                where: { id: accountId },
                select: { id: true },
            });
            return existing
                ? { status: 'pending' as const }
                : { status: 'deleted' as const, relationshipPeerIds: [] };
        }

        const account = await tx.account.findUnique({
            where: { id: accountId },
            select: {
                deletionRequestedAt: true,
            },
        });
        if (!account) {
            return { status: 'deleted' as const, relationshipPeerIds: [] };
        }
        if (!account.deletionRequestedAt) {
            return { status: 'pending' as const };
        }
        const activeVoiceAdmission = await tx.accountDeletionVoiceAdmission.findFirst({
            where: {
                accountId,
                OR: [
                    { completedAt: null },
                    {
                        credentialIssuedAt: { not: null },
                        OR: [
                            { expiresAt: null },
                            { expiresAt: { gt: now } },
                        ],
                    },
                ],
            },
            select: { id: true },
        });
        if (activeVoiceAdmission) {
            return { status: 'pending' as const };
        }
        const activeGithubOAuthAdmission = await tx.accountDeletionGithubOAuthAdmission.findFirst({
            where: {
                accountId,
                callbackStartedAt: { not: null },
                completedAt: null,
            },
            select: { id: true },
        });
        if (activeGithubOAuthAdmission) {
            return { status: 'pending' as const };
        }

        // Historical image URL reuse was not account-scoped. Clear any stale
        // profile reference into this account's prefix before its objects are
        // removed, so another account cannot retain a deleted account ID/path.
        await tx.account.updateMany({
            where: {
                avatar: {
                    path: ['path'],
                    string_starts_with: `public/users/${accountId}/`,
                },
            },
            data: { avatar: Prisma.DbNull },
        });

        const currentSessions = await tx.session.findMany({
            where: { accountId },
            select: { id: true },
        });
        if (currentSessions.some((session) => !cleanedSessionIds.has(session.id))) {
            return { status: 'pending' as const };
        }
        const sessionIdsToDelete = currentSessions.map((session) => session.id);
        const machines = await tx.machine.findMany({
            where: { accountId },
            select: { credentialId: true },
        });
        const machineCredentialIds = machines.flatMap((machine) => (
            machine.credentialId ? [machine.credentialId] : []
        ));
        const relationships = await tx.userRelationship.findMany({
            where: {
                OR: [
                    { fromUserId: accountId },
                    { toUserId: accountId },
                ],
            },
            select: { fromUserId: true, toUserId: true },
        });
        // Remove every key that references a session being erased, including a
        // malformed historical cross-account row that would otherwise block
        // the required Session foreign key.
        await tx.accessKey.deleteMany({
            where: {
                OR: [
                    { accountId },
                    { sessionId: { in: sessionIdsToDelete } },
                ],
            },
        });
        await tx.sessionMessage.deleteMany({
            where: { sessionId: { in: sessionIdsToDelete } },
        });
        await tx.usageReport.deleteMany({ where: { accountId } });
        await tx.session.deleteMany({ where: { accountId } });
        // Machine.credential uses onDelete:SetNull, so erase those credential
        // requests before deleting the Machine rows instead of orphaning them.
        await tx.terminalAuthRequest.deleteMany({
            where: {
                OR: [
                    { responseAccountId: accountId },
                    { id: { in: machineCredentialIds } },
                ],
            },
        });
        await tx.machine.deleteMany({ where: { accountId } });
        await tx.accountAuthRequest.deleteMany({ where: { responseAccountId: accountId } });
        await tx.accountPushToken.deleteMany({ where: { accountId } });
        await tx.uploadedFile.deleteMany({ where: { accountId } });
        await tx.serviceAccountToken.deleteMany({ where: { accountId } });
        await tx.artifact.deleteMany({ where: { accountId } });
        await tx.userRelationship.deleteMany({
            where: {
                OR: [
                    { fromUserId: accountId },
                    { toUserId: accountId },
                ],
            },
        });
        await tx.userFeedItem.deleteMany({
            where: {
                OR: [
                    { userId: accountId },
                    { body: { path: ['uid'], equals: accountId } },
                ],
            },
        });
        await tx.userKVStore.deleteMany({ where: { accountId } });
        await tx.voiceConversation.deleteMany({ where: { accountId } });
        await tx.accountDeletionVoiceAdmission.deleteMany({ where: { accountId } });
        await tx.accountDeletionGithubOAuthAdmission.deleteMany({ where: { accountId } });
        await tx.account.delete({ where: { id: accountId } });
        // GithubUser has a one-way relation from Account. Old versions could
        // leave an OAuth record orphaned during reconnect races, so remove
        // every record no account can still reference after this deletion.
        await tx.githubUser.deleteMany({ where: { Account: { none: {} } } });

        return {
            status: 'deleted' as const,
            relationshipPeerIds: [...new Set(relationships.map((relationship) => (
                relationship.fromUserId === accountId
                    ? relationship.toUserId
                    : relationship.fromUserId
            )))],
        };
    });
}

async function hasPendingAccountDeletionUploads(accountId: string): Promise<boolean> {
    const operation = await db.accountDeletionUploadOperation.findFirst({
        where: { accountId, completedAt: null },
        select: { id: true, objectKey: true },
    });
    return operation !== null;
}

async function hasActiveVoiceCredentialAdmissions(accountId: string): Promise<boolean> {
    const now = new Date();
    await db.accountDeletionVoiceAdmission.deleteMany({
        where: {
            accountId,
            OR: [
                { completedAt: { not: null }, credentialIssuedAt: null },
                {
                    completedAt: { not: null },
                    credentialIssuedAt: { not: null },
                    expiresAt: { lte: now },
                },
            ],
        },
    });
    const admission = await db.accountDeletionVoiceAdmission.findFirst({
        where: {
            accountId,
            OR: [
                { completedAt: null },
                {
                    credentialIssuedAt: { not: null },
                    OR: [
                        { expiresAt: null },
                        { expiresAt: { gt: now } },
                    ],
                },
            ],
        },
        select: { id: true },
    });
    return admission !== null;
}

async function cleanupInactiveGithubOAuthAdmissions(): Promise<void> {
    const now = new Date();
    await db.accountDeletionGithubOAuthAdmission.deleteMany({
        where: {
            OR: [
                { completedAt: { not: null } },
                {
                    callbackStartedAt: null,
                    completedAt: null,
                    expiresAt: { lte: now },
                },
            ],
        },
    });
}

async function hasClaimedGithubOAuthAdmission(accountId: string): Promise<boolean> {
    await cleanupInactiveGithubOAuthAdmissions();
    const admission = await db.accountDeletionGithubOAuthAdmission.findFirst({
        where: {
            accountId,
            callbackStartedAt: { not: null },
            completedAt: null,
        },
        select: { id: true },
    });
    return admission !== null;
}

/**
 * Recover operations whose HTTP write returned an ambiguous result. A
 * positive object-store probe is deleted by exact key, but the operation is
 * never completed by a read-side probe. An in-flight provider write can be
 * accepted before it becomes visible (or can reappear after a delete), so only
 * the upload request itself may settle the operation. This is intentionally
 * conservative: an ambiguous failed request can keep deletion pending until
 * an operator or a later successful retry provides a write-side boundary.
 */
async function reconcilePendingAccountDeletionUploads(
    accountId: string,
    assertLease: () => Promise<void>,
): Promise<void> {
    const operations = await db.accountDeletionUploadOperation.findMany({
        where: { accountId, completedAt: null },
        select: { id: true, objectKey: true },
        orderBy: { createdAt: 'asc' },
        take: 100,
    });
    for (const operation of operations) {
        await assertLease();
        const probe = await probeFile(operation.objectKey);
        if (probe !== 'present') continue;
        {
            try {
                await deleteFile(operation.objectKey);
            } catch {
                continue;
            }
        }
    }
}

/**
 * Historical session deletion was best-effort, so some object prefixes no
 * longer have a database Session to associate with an account. Sweep those
 * prefixes globally, with a durable lease and cooldown, rather than forcing a
 * full bucket scan on every account-deletion retry.
 */
async function ensureOrphanedSessionAttachmentsCleanedAfter(requestedAt: Date): Promise<boolean> {
    const now = new Date();
    const existing = await db.globalLock.findUnique({
        where: { key: ORPHAN_ATTACHMENT_SWEEP_LOCK_KEY },
        select: { value: true, updatedAt: true, expiresAt: true },
    });
    if (existing?.value === 'completed' && existing.updatedAt >= requestedAt) {
        return true;
    }
    if (existing && existing.expiresAt > now) {
        return false;
    }

    const token = randomBytes(16).toString('hex');
    const leaseExpiresAt = new Date(now.getTime() + ORPHAN_ATTACHMENT_SWEEP_LEASE_MS);
    let claimed = false;
    if (existing) {
        const result = await db.globalLock.updateMany({
            where: {
                key: ORPHAN_ATTACHMENT_SWEEP_LOCK_KEY,
                expiresAt: { lte: now },
            },
            data: { value: token, expiresAt: leaseExpiresAt },
        });
        claimed = result.count === 1;
    } else {
        try {
            await db.globalLock.create({
                data: {
                    key: ORPHAN_ATTACHMENT_SWEEP_LOCK_KEY,
                    value: token,
                    expiresAt: leaseExpiresAt,
                },
            });
            claimed = true;
        } catch {
            // Another process created the singleton first; it will do the scan.
            return false;
        }
    }
    if (!claimed) return false;

    try {
        await deleteOrphanedSessionAttachments();
        const completedAt = new Date();
        const result = await db.globalLock.updateMany({
            where: { key: ORPHAN_ATTACHMENT_SWEEP_LOCK_KEY, value: token },
            data: {
                value: 'completed',
                expiresAt: new Date(completedAt.getTime() + ORPHAN_ATTACHMENT_SWEEP_COOLDOWN_MS),
            },
        });
        return result.count === 1 && completedAt >= requestedAt;
    } catch (error) {
        await db.globalLock.updateMany({
            where: { key: ORPHAN_ATTACHMENT_SWEEP_LOCK_KEY, value: token },
            data: { value: 'failed', expiresAt: new Date() },
        });
        throw error;
    }
}

async function deleteOrphanedSessionAttachments(): Promise<void> {
    await forEachSessionAttachmentId(async (sessionIds) => {
        const existing = await db.session.findMany({
            where: { id: { in: [...sessionIds] } },
            select: { id: true },
        });
        const existingSessionIds = new Set(existing.map((session) => session.id));
        for (const sessionId of sessionIds) {
            if (!existingSessionIds.has(sessionId)) {
                await deleteSessionAttachments(sessionId);
            }
        }
    });
}

async function notifyRelationshipPeers(accountId: string, peerIds: readonly string[]): Promise<void> {
    for (const peerId of peerIds) {
        try {
            const updateSeq = await allocateUserSeq(peerId);
            if (updateSeq === null) continue;
            eventRouter.emitUpdate({
                userId: peerId,
                payload: buildRelationshipUpdatedEvent({
                    uid: accountId,
                    status: 'none',
                    timestamp: Date.now(),
                }, updateSeq, randomKeyNaked(12)),
                recipientFilter: { type: 'user-scoped-only' },
            });
        } catch {
            log({
                module: 'account-deletion',
                level: 'error',
                userHash: diagnosticHash(peerId),
            }, 'Failed to notify relationship peer of account deletion');
        }
    }
}
