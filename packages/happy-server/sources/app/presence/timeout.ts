import { db } from "@/storage/db";
import { delay } from "@/utils/delay";
import { forever } from "@/utils/forever";
import { shutdownSignal } from "@/utils/shutdown";
import { buildMachineActivityEphemeral, buildSessionActivityEphemeral, eventRouter } from "@/app/events/eventRouter";

const SESSION_TIMEOUT_MS = 1000 * 60 * 10;

export async function expireTimedOutSessions(now = Date.now()): Promise<void> {
    const sessions = await db.session.findMany({
        where: {
            active: true,
            archivedAt: null,
            lastActiveAt: {
                lte: new Date(now - SESSION_TIMEOUT_MS),
            },
        },
        select: {
            id: true,
            accountId: true,
            lastActiveAt: true,
        },
    });
    for (const session of sessions) {
        const updated = await db.session.updateManyAndReturn({
            where: {
                id: session.id,
                active: true,
                archivedAt: null,
                lastActiveAt: session.lastActiveAt,
            },
            data: { active: false, presenceLeaseId: null },
        });
        if (updated.length === 0) {
            continue;
        }
        eventRouter.emitEphemeral({
            userId: session.accountId,
            payload: buildSessionActivityEphemeral(
                session.id,
                false,
                updated[0].lastActiveAt.getTime(),
                false,
                null,
            ),
            recipientFilter: { type: 'user-scoped-only' },
        });
    }
}

export function startTimeout() {
    forever('session-timeout', async () => {
        while (true) {
            await expireTimedOutSessions();

            // Find timed out machines
            const machines = await db.machine.findMany({
                where: {
                    active: true,
                    lastActiveAt: {
                        lte: new Date(Date.now() - 1000 * 60 * 10) // 10 minutes
                    }
                }
            });
            for (const machine of machines) {
                const updated = await db.machine.updateManyAndReturn({
                    where: { id: machine.id, active: true },
                    data: { active: false }
                });
                if (updated.length === 0) {
                    continue;
                }
                eventRouter.emitEphemeral({
                    userId: machine.accountId,
                    payload: buildMachineActivityEphemeral(machine.id, false, updated[0].lastActiveAt.getTime()),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            // Wait for 1 minute
            await delay(1000 * 60, shutdownSignal);
        }
    });
}
