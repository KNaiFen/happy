import { db } from "@/storage/db";
import { Context } from "@/context";
import { allocateUserSeq } from "@/storage/seq";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { inTx, afterTx } from "@/storage/inTx";
import { requireAccountWrite } from "@/app/account/accountWriteGate";

export async function usernameUpdate(ctx: Context, username: string): Promise<void> {
    const userId = ctx.uid;

    await inTx(async (tx) => {
        await requireAccountWrite(tx, userId);

        // Keep uniqueness check and update under the same account write gate.
        const existingUser = await tx.account.findFirst({
            where: {
                username,
                NOT: { id: userId },
                deletionRequestedAt: null,
            }
        });
        if (existingUser) {
            throw new Error('Username is already taken');
        }

        await tx.account.update({
            where: { id: userId },
            data: { username }
        });
    });

    // Send account update to all user connections
    const updSeq = await allocateUserSeq(userId);
    if (updSeq === null) return;
    const updatePayload = buildUpdateAccountUpdate(userId, { username }, updSeq, randomKeyNaked(12));
    eventRouter.emitUpdate({ userId, payload: updatePayload, recipientFilter: { type: 'user-scoped-only' } });
}
