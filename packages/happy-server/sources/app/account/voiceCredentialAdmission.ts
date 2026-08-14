import { acquireAccountWrite } from '@/app/account/accountWriteGate';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';

export interface VoiceCredentialAdmission {
    id: string;
    accountId: string;
}

export class VoiceCredentialResponseOutcomeUnknownError extends Error {
    constructor() {
        super('Voice credential response outcome is unknown');
        this.name = 'VoiceCredentialResponseOutcomeUnknownError';
    }
}

/** Persist admission before asking the provider to mint a bearer credential. */
export async function beginVoiceCredentialAdmission(
    accountId: string,
): Promise<VoiceCredentialAdmission | null> {
    return inTx(async (tx) => {
        if (!(await acquireAccountWrite(tx, accountId))) return null;
        return tx.accountDeletionVoiceAdmission.create({
            data: {
                accountId,
                // No trustworthy expiry exists until the provider returns a
                // signed JWT. An in-flight or ambiguous request must remain
                // durable so deletion cannot guess that no credential escaped.
                expiresAt: null,
            },
            select: { id: true, accountId: true },
        });
    });
}

/** Settle an admission on a path that is known not to have sent a credential. */
export async function settleVoiceCredentialAdmission(
    admission: VoiceCredentialAdmission,
): Promise<void> {
    const settled = await db.accountDeletionVoiceAdmission.updateMany({
        where: {
            id: admission.id,
            accountId: admission.accountId,
            completedAt: null,
        },
        data: { completedAt: new Date() },
    });
    if (settled.count !== 1) return;
    try {
        await db.accountDeletionVoiceAdmission.deleteMany({
            where: { id: admission.id, completedAt: { not: null } },
        });
    } catch {
        // completedAt is the durable boundary; cleanup can be retried later.
    }
}

/** Persist the provider credential's lifetime before any response can expose it. */
export async function armVoiceCredentialAdmission(
    admission: VoiceCredentialAdmission,
    credentialExpiresAt: Date,
): Promise<boolean> {
    if (!Number.isFinite(credentialExpiresAt.getTime()) || credentialExpiresAt <= new Date()) {
        return false;
    }
    return inTx(async (tx) => {
        if (!(await acquireAccountWrite(tx, admission.accountId))) return false;
        const armed = await tx.accountDeletionVoiceAdmission.updateMany({
            where: {
                id: admission.id,
                accountId: admission.accountId,
                completedAt: null,
            },
            data: { expiresAt: credentialExpiresAt },
        });
        return armed.count === 1;
    });
}

/**
 * Send the credential while holding the Account row lock. This intentionally
 * uses one non-retrying transaction: retrying an HTTP side effect could send
 * the response twice. If commit becomes ambiguous after send(), the durable
 * pending admission remains and deletion fails closed.
 */
export async function sendVoiceCredentialForAdmission(
    admission: VoiceCredentialAdmission,
    send: () => void,
): Promise<boolean> {
    let responseSent = false;
    try {
        return await db.$transaction(async (tx) => {
            const writable = await acquireAccountWrite(tx, admission.accountId);
            if (!writable) return false;
            const responseBoundary = new Date();
            const settled = await tx.accountDeletionVoiceAdmission.updateMany({
                where: {
                    id: admission.id,
                    accountId: admission.accountId,
                    completedAt: null,
                },
                data: {
                    completedAt: responseBoundary,
                    credentialIssuedAt: responseBoundary,
                },
            });
            if (settled.count !== 1) return false;
            responseSent = true;
            send();
            return true;
        }, { isolationLevel: 'Serializable', timeout: 10_000 });
    } catch (error) {
        if (responseSent) throw new VoiceCredentialResponseOutcomeUnknownError();
        throw error;
    }
}

/** Send a non-credential response before a concurrent deletion can commit. */
export async function sendActiveAccountResponse(
    accountId: string,
    send: () => void,
): Promise<boolean> {
    let responseSent = false;
    try {
        return await db.$transaction(async (tx) => {
            if (!(await acquireAccountWrite(tx, accountId))) return false;
            send();
            responseSent = true;
            return true;
        }, { isolationLevel: 'Serializable', timeout: 10_000 });
    } catch (error) {
        if (responseSent) return true;
        throw error;
    }
}
