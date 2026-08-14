import { Context } from "@/context";
import { log } from "@/utils/log";
import { allocateUserSeq } from "@/storage/seq";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { inTx } from "@/storage/inTx";
import { diagnosticHash } from "@/utils/diagnosticHash";

/**
 * Disconnects a GitHub account from a user profile.
 * 
 * Flow:
 * 1. Check if user has GitHub connected - early exit if not
 * 2. In transaction: clear GitHub link and username from account (keeps avatar) and delete GitHub user record
 * 3. Send socket update after transaction completes
 * 
 * @param ctx - Request context containing user ID
 */
export async function githubDisconnect(ctx: Context): Promise<void> {
    const userId = ctx.uid;

    const githubUserId = await inTx(async (tx) => {
        const user = await tx.account.findUnique({
            where: { id: userId },
            select: { githubUserId: true },
        });
        if (!user?.githubUserId) return null;

        // Match the identifier we read so a reconnect cannot clear a newer
        // link, and do not mutate an account that has entered deletion.
        const disconnected = await tx.account.updateMany({
            where: {
                id: userId,
                githubUserId: user.githubUserId,
                deletionRequestedAt: null,
            },
            data: {
                githubUserId: null,
                username: null,
            },
        });
        if (disconnected.count !== 1) return null;

        await tx.githubUser.deleteMany({
            where: {
                id: user.githubUserId,
                Account: { none: {} },
            },
        });
        return user.githubUserId;
    });

    if (!githubUserId) {
        log({
            module: 'github-disconnect',
            userHash: diagnosticHash(userId),
        }, 'GitHub disconnect skipped');
        return;
    }

    const diagnosticFields = {
        module: 'github-disconnect',
        userHash: diagnosticHash(userId),
        githubUserHash: diagnosticHash(githubUserId),
    };
    log(diagnosticFields, 'Disconnecting GitHub account');

    // Send update via socket after the transaction completes.
    const updSeq = await allocateUserSeq(userId);
    if (updSeq === null) return;
    const updatePayload = buildUpdateAccountUpdate(userId, {
        github: null,
        username: null
    }, updSeq, randomKeyNaked(12));

    eventRouter.emitUpdate({
        userId,
        payload: updatePayload,
        recipientFilter: { type: 'user-scoped-only' }
    });

    log(diagnosticFields, 'GitHub account disconnected');
}
