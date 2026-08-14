import type { Prisma } from '@prisma/client';

/**
 * Acquire the account row as a write gate for account-scoped mutations.
 *
 * The conditional update is intentionally performed inside the caller's
 * Serializable transaction. It makes the deletion marker and ordinary writes
 * compete for the same row lock: a write admitted before deletion may commit
 * and will be removed by the final sweep, while a write that observes the
 * marker is rejected before it can create/update account data.
 */
export async function acquireAccountWrite(
    tx: Pick<Prisma.TransactionClient, 'account'>,
    accountId: string,
): Promise<boolean> {
    const result = await tx.account.updateMany({
        where: {
            id: accountId,
            deletionRequestedAt: null,
        },
        data: { updatedAt: new Date() },
    });
    return result.count === 1;
}

/**
 * Acquire the same account-row admission lock for a read operation.
 *
 * Reads run in the caller's Serializable transaction so the deletion marker
 * cannot commit between admission and the query. We intentionally share the
 * conditional row update with writes instead of issuing a database-specific
 * FOR UPDATE statement; this keeps PostgreSQL and the local PGlite adapter on
 * the same lock protocol.
 */
export async function acquireAccountRead(
    tx: Pick<Prisma.TransactionClient, 'account'>,
    accountId: string,
): Promise<boolean> {
    return acquireAccountWrite(tx, accountId);
}

/** Raise a typed error for service-layer mutations that cannot continue. */
export class AccountWriteBlockedError extends Error {
    readonly statusCode = 409;

    constructor() {
        super('account deletion in progress');
        this.name = 'AccountWriteBlockedError';
    }
}

export async function requireAccountWrite(
    tx: Pick<Prisma.TransactionClient, 'account'>,
    accountId: string,
): Promise<void> {
    if (!await acquireAccountWrite(tx, accountId)) {
        throw new AccountWriteBlockedError();
    }
}

/** Acquire multiple account rows in a stable order to avoid reciprocal-write deadlocks. */
export async function requireAccountWrites(
    tx: Pick<Prisma.TransactionClient, 'account'>,
    accountIds: readonly string[],
): Promise<void> {
    for (const accountId of [...new Set(accountIds)].sort()) {
        await requireAccountWrite(tx, accountId);
    }
}
