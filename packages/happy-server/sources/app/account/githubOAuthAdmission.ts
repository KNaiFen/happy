import { acquireAccountWrite } from '@/app/account/accountWriteGate';
import { GITHUB_OAUTH_STATE_TTL_MS } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { randomKeyNaked } from '@/utils/randomKeyNaked';

export interface GithubOAuthAdmission {
    id: string;
    accountId: string;
}

export async function beginGithubOAuthAdmission(
    accountId: string,
    issueState: (admissionId: string) => Promise<string>,
): Promise<{ admission: GithubOAuthAdmission; state: string } | null> {
    const admissionId = randomKeyNaked(24);
    return inTx(async (tx) => {
        if (!(await acquireAccountWrite(tx, accountId))) return null;
        const state = await issueState(admissionId);
        const admission = await tx.accountDeletionGithubOAuthAdmission.create({
            data: {
                id: admissionId,
                accountId,
                expiresAt: new Date(Date.now() + GITHUB_OAUTH_STATE_TTL_MS),
            },
            select: { id: true, accountId: true },
        });
        return { admission, state };
    });
}

export async function claimGithubOAuthAdmission(
    admission: GithubOAuthAdmission,
): Promise<boolean> {
    return inTx((tx) => claimGithubOAuthAdmissionInTransaction(tx, admission));
}

export async function claimGithubOAuthAdmissionInTransaction(
    tx: Tx,
    admission: GithubOAuthAdmission,
): Promise<boolean> {
    if (!(await acquireAccountWrite(tx, admission.accountId))) return false;
    const now = new Date();
    const claimed = await tx.accountDeletionGithubOAuthAdmission.updateMany({
        where: {
            id: admission.id,
            accountId: admission.accountId,
            callbackStartedAt: null,
            completedAt: null,
            expiresAt: { gt: now },
        },
        data: { callbackStartedAt: now },
    });
    return claimed.count === 1;
}

export async function settleGithubOAuthAdmission(
    admission: GithubOAuthAdmission,
): Promise<void> {
    const settled = await db.accountDeletionGithubOAuthAdmission.updateMany({
        where: {
            id: admission.id,
            accountId: admission.accountId,
            callbackStartedAt: { not: null },
            completedAt: null,
        },
        data: { completedAt: new Date() },
    });
    if (settled.count !== 1) {
        throw new Error('Failed to persist GitHub OAuth completion');
    }
    try {
        await db.accountDeletionGithubOAuthAdmission.deleteMany({
            where: { id: admission.id, completedAt: { not: null } },
        });
    } catch {
        // completedAt is the durable boundary; deletion cleanup can retry.
    }
}
