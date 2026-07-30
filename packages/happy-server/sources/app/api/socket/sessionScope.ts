import type { Prisma } from "@prisma/client";
import type { ClientConnection } from "@/app/events/eventRouter";
import { buildSessionAccessWhere } from "../utils/sessionAccess";

export function sessionWhereForConnection(
    userId: string,
    connection: ClientConnection,
    sessionId: string,
): Prisma.SessionWhereInput | null {
    if (
        connection.connectionType === "session-scoped"
        && connection.sessionId !== sessionId
    ) {
        return null;
    }
    if (connection.connectionType === "user-scoped" && connection.credentialId) {
        return null;
    }
    if (connection.connectionType === "machine-scoped" && !connection.credentialId) {
        return null;
    }

    return buildSessionAccessWhere({
        userId,
        credentialId: connection.credentialId,
        machineId: connection.connectionType === "user-scoped"
            ? undefined
            : connection.machineId,
    }, { id: sessionId });
}
