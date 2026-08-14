import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { acquireAccountRead, acquireAccountWrite } from "@/app/account/accountWriteGate";

export interface SocketScopeInput {
    userId: string;
    credentialId?: string;
    clientType?: 'session-scoped' | 'user-scoped' | 'machine-scoped';
    sessionId?: string;
    machineId?: string;
}

export async function authorizeSocketScope(input: SocketScopeInput): Promise<boolean> {
    if (input.clientType === 'machine-scoped') {
        if (!input.credentialId || !input.machineId) return false;
        return inTx(async (tx) => {
            if (!await acquireAccountRead(tx, input.userId)) return false;
            const machine = await tx.machine.findFirst({
                where: {
                    id: input.machineId,
                    accountId: input.userId,
                    deletedAt: null,
                    account: { is: { deletionRequestedAt: null } },
                },
                select: { credentialId: true },
            });
            if (!machine) return false;
            if (machine.credentialId && machine.credentialId !== input.credentialId) {
                return false;
            }
            if (!machine.credentialId) {
                if (!await acquireAccountWrite(tx, input.userId)) return false;
                const updated = await tx.machine.updateMany({
                    where: {
                        id: input.machineId,
                        accountId: input.userId,
                        credentialId: null,
                        deletedAt: null,
                        account: { is: { deletionRequestedAt: null } },
                    },
                    data: { credentialId: input.credentialId },
                });
                return updated.count === 1;
            }
            return true;
        });
    }

    if (input.clientType !== 'session-scoped') {
        if (input.credentialId) return false;
        return inTx(async (tx) => acquireAccountRead(tx, input.userId));
    }
    if (!input.sessionId) return false;
    return inTx(async (tx) => {
        if (!await acquireAccountRead(tx, input.userId)) return false;
        const session = await tx.session.findFirst({
            where: { id: input.sessionId, accountId: input.userId, archivedAt: null, account: { is: { deletionRequestedAt: null } } },
            select: {
                originMachineId: true,
                originMachine: {
                    select: {
                        accountId: true,
                        credentialId: true,
                        deletedAt: true,
                    },
                },
            },
        });
        if (!session) return false;
        if (!input.credentialId) return true;
        if (!input.machineId) return false;

        const machine = await tx.machine.findFirst({
            where: {
                id: input.machineId,
                accountId: input.userId,
                credentialId: input.credentialId,
                deletedAt: null,
                account: { is: { deletionRequestedAt: null } },
            },
            select: { id: true },
        });
        if (!machine) return false;
        return Boolean(session.originMachineId
            && session.originMachineId === input.machineId
            && session.originMachine?.accountId === input.userId
            && session.originMachine.credentialId === input.credentialId
            && session.originMachine.deletedAt === null);
    });
}
