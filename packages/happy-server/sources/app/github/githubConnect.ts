import { db } from "@/storage/db";
import { Context } from "@/context";
import { encryptString } from "@/modules/encrypt";
import { uploadImage } from "@/storage/uploadImage";
import { separateName } from "@/utils/separateName";
import { GitHubProfile } from "@/app/api/types";
import { allocateUserSeq } from "@/storage/seq";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { githubDisconnect } from "./githubDisconnect";
import { inTx } from "@/storage/inTx";

/**
 * Connects a GitHub account to a user profile.
 * 
 * Flow:
 * 1. Check if already connected to same account - early exit if yes
 * 2. If GitHub account is connected to another user - disconnect it first
 * 3. Upload avatar to S3 (non-transactional operation)
 * 4. In transaction: persist GitHub account and link to user with GitHub username
 * 5. Send socket update after transaction completes
 * 
 * @param ctx - Request context containing user ID
 * @param githubProfile - GitHub profile data from OAuth
 * @param accessToken - GitHub access token for API access
 */
export async function githubConnect(
    ctx: Context,
    githubProfile: GitHubProfile,
    accessToken: string
): Promise<void> {
    const userId = ctx.uid;
    const githubUserId = githubProfile.id.toString();

    // Step 1: Check if user is already connected to this exact GitHub account
    const currentUser = await db.account.findFirstOrThrow({
        where: {
            id: userId,
            deletionRequestedAt: null,
        },
        select: { githubUserId: true, username: true }
    });
    if (currentUser.githubUserId === githubUserId) {
        return;
    }

    // Step 2: Check if GitHub account is connected to another user
    const existingConnection = await db.account.findFirst({
        where: {
            githubUserId: githubUserId,
            NOT: { id: userId }
        }
    });
    if (existingConnection) {
        const disconnectCtx: Context = Context.create(existingConnection.id);
        await githubDisconnect(disconnectCtx);
    }

    // Step 3: Upload avatar to S3 (outside transaction for performance)
    const imageResponse = await fetch(githubProfile.avatar_url);
    const imageBuffer = await imageResponse.arrayBuffer();
    const avatar = await uploadImage(userId, 'avatars', 'github', githubProfile.avatar_url, Buffer.from(imageBuffer));

    // Extract name from GitHub profile
    const name = separateName(githubProfile.name);

    // Step 4: Start transaction for atomic database operations
    await inTx(async (tx) => {
        // Serialize the connection write with account deletion. The initial
        // OAuth-state check is intentionally not the authority because the
        // callback performs external requests before reaching this transaction.
        const locked = await tx.account.updateMany({
            where: {
                id: userId,
                deletionRequestedAt: null,
            },
            data: { updatedAt: new Date() },
        });
        if (locked.count !== 1) {
            throw new Error('Account deletion in progress');
        }
        const account = await tx.account.findUniqueOrThrow({
            where: { id: userId },
            select: { githubUserId: true },
        });

        // Upsert GitHub user record with encrypted token
        await tx.githubUser.upsert({
            where: { id: githubUserId },
            update: {
                profile: githubProfile,
                token: encryptString(['user', userId, 'github', 'token'], accessToken)
            },
            create: {
                id: githubUserId,
                profile: githubProfile,
                token: encryptString(['user', userId, 'github', 'token'], accessToken)
            }
        });

        // Link GitHub account to user
        await tx.account.update({
            where: { id: userId },
            data: {
                githubUserId: githubUserId,
                username: githubProfile.login,
                firstName: name.firstName,
                lastName: name.lastName,
                avatar: avatar
            }
        });
        if (account.githubUserId && account.githubUserId !== githubUserId) {
            await tx.githubUser.deleteMany({
                where: {
                    id: account.githubUserId,
                    Account: { none: {} },
                },
            });
        }
    });

    // Step 5: Send update via socket (after transaction completes)
    const updSeq = await allocateUserSeq(userId);
    if (updSeq === null) return;
    const updatePayload = buildUpdateAccountUpdate(userId, {
        github: githubProfile,
        username: githubProfile.login,
        firstName: name.firstName,
        lastName: name.lastName,
        avatar: avatar
    }, updSeq, randomKeyNaked(12));

    eventRouter.emitUpdate({
        userId,
        payload: updatePayload,
        recipientFilter: { type: 'user-scoped-only' }
    });
}
