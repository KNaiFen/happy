import { Context } from "@/context";
import { inTx, afterTx } from "@/storage/inTx";
import { eventRouter, buildDeleteSessionUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";
import { deleteSessionAttachments } from "@/storage/files";
import { diagnosticHash } from "@/utils/diagnosticHash";
import {
    buildSessionAccessWhere,
    type SessionAccessIdentity,
} from "@/app/api/utils/sessionAccess";

/**
 * Delete a session and all its related data.
 * Handles:
 * - Deleting all session messages
 * - Deleting all usage reports for the session
 * - Deleting all access keys for the session
 * - Deleting the session itself
 * - Sending socket notification to all connected clients
 * 
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to delete
 * @returns true if deletion was successful, false if session not found or not owned by user
 */
export async function sessionDelete(
    ctx: Context,
    sessionId: string,
    identity: SessionAccessIdentity = { userId: ctx.uid },
): Promise<boolean> {
    return await inTx(async (tx) => {
        const accessWhere = buildSessionAccessWhere(identity, { id: sessionId });
        if (!accessWhere) return false;
        // Verify session exists and belongs to the user
        const session = await tx.session.findFirst({
            where: accessWhere,
        });

        if (!session) {
            log({ 
                module: 'session-delete', 
                userHash: diagnosticHash(ctx.uid),
                sessionHash: diagnosticHash(sessionId),
            }, `Session not found or not owned by user`);
            return false;
        }

        // Delete all related data
        // Note: Order matters to avoid foreign key constraint violations
        
        // 1. Delete session messages
        const deletedMessages = await tx.sessionMessage.deleteMany({
            where: { sessionId }
        });
        log({ 
            module: 'session-delete', 
            userHash: diagnosticHash(ctx.uid),
            sessionHash: diagnosticHash(sessionId),
            deletedCount: deletedMessages.count
        }, `Deleted ${deletedMessages.count} session messages`);

        // 2. Delete usage reports
        const deletedReports = await tx.usageReport.deleteMany({
            where: { sessionId }
        });
        log({ 
            module: 'session-delete', 
            userHash: diagnosticHash(ctx.uid),
            sessionHash: diagnosticHash(sessionId),
            deletedCount: deletedReports.count
        }, `Deleted ${deletedReports.count} usage reports`);

        // 3. Delete access keys
        const deletedAccessKeys = await tx.accessKey.deleteMany({
            where: { sessionId }
        });
        log({ 
            module: 'session-delete', 
            userHash: diagnosticHash(ctx.uid),
            sessionHash: diagnosticHash(sessionId),
            deletedCount: deletedAccessKeys.count
        }, `Deleted ${deletedAccessKeys.count} access keys`);

        // 4. Delete the session itself
        await tx.session.delete({
            where: { id: sessionId }
        });
        log({ 
            module: 'session-delete', 
            userHash: diagnosticHash(ctx.uid),
            sessionHash: diagnosticHash(sessionId),
        }, `Session deleted successfully`);

        // Send notification and clean up storage after transaction commits
        afterTx(tx, async () => {
            const updSeq = await allocateUserSeq(ctx.uid);
            const updatePayload = buildDeleteSessionUpdate(sessionId, updSeq, randomKeyNaked(12));

            log({
                module: 'session-delete',
                userHash: diagnosticHash(ctx.uid),
                sessionHash: diagnosticHash(sessionId),
                updateType: 'delete-session',
            }, `Emitting delete-session update to user-scoped connections`);

            eventRouter.emitUpdate({
                userId: ctx.uid,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            // Delete attachment blobs (local dir or S3 prefix)
            try {
                await deleteSessionAttachments(sessionId);
                log({
                    module: 'session-delete',
                    userHash: diagnosticHash(ctx.uid),
                    sessionHash: diagnosticHash(sessionId),
                }, `Attachment blobs deleted`);
            } catch {
                log({
                    module: 'session-delete',
                    userHash: diagnosticHash(ctx.uid),
                    sessionHash: diagnosticHash(sessionId),
                }, `Failed to delete attachment blobs (non-fatal)`);
            }
        });

        return true;
    });
}
