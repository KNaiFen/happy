import { db } from "@/storage/db";

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
        const machine = await db.machine.findFirst({
            where: {
                id: input.machineId,
                accountId: input.userId,
                deletedAt: null,
            },
            select: { credentialId: true },
        });
        if (!machine) return false;
        if (machine.credentialId && machine.credentialId !== input.credentialId) {
            return false;
        }
        if (!machine.credentialId) {
            const bound = await db.machine.updateMany({
                where: {
                    id: input.machineId,
                    accountId: input.userId,
                    credentialId: null,
                    deletedAt: null,
                },
                data: { credentialId: input.credentialId },
            });
            return bound.count === 1;
        }
        return true;
    }

    if (input.clientType !== 'session-scoped') {
        return !input.credentialId;
    }
    if (!input.sessionId) return false;
    const session = await db.session.findFirst({
        where: { id: input.sessionId, accountId: input.userId },
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

    const machine = await db.machine.findFirst({
        where: {
            id: input.machineId,
            accountId: input.userId,
            credentialId: input.credentialId,
            deletedAt: null,
        },
        select: { id: true },
    });
    if (!machine) return false;
    if (session.originMachineId) {
        return session.originMachineId === input.machineId
            && session.originMachine?.accountId === input.userId
            && session.originMachine.credentialId === input.credentialId
            && session.originMachine.deletedAt === null;
    }
    return false;
}
