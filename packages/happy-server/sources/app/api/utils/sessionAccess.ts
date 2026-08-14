import type { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";

export interface SessionAccessIdentity {
    userId: string;
    credentialId?: string;
    machineId?: string;
}

export function sessionAccessIdentityFromRequest(
    request: FastifyRequest,
): SessionAccessIdentity {
    return {
        userId: request.userId,
        credentialId: request.authCredentialId,
        machineId: request.authMachineId,
    };
}

export function buildSessionAccessWhere(
    identity: SessionAccessIdentity,
    constraints: Prisma.SessionWhereInput = {},
): Prisma.SessionWhereInput | null {
    const base = {
        ...constraints,
        accountId: identity.userId,
        account: { is: { deletionRequestedAt: null } },
    };
    if (!identity.credentialId) return base;
    if (!identity.machineId) return null;

    return {
        ...base,
        originMachineId: identity.machineId,
        originMachine: {
            is: {
                accountId: identity.userId,
                credentialId: identity.credentialId,
                deletedAt: null,
            },
        },
    };
}
