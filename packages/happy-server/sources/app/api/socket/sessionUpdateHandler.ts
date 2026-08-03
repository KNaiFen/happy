import {
    buildUpdateSessionUpdate,
    type ClientConnection,
    eventRouter,
} from '@/app/events/eventRouter';
import { db } from '@/storage/db';
import { allocateUserSeq } from '@/storage/seq';
import { log } from '@/utils/log';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import type { Socket } from 'socket.io';
import { sessionWriteWhereForConnection } from './sessionScope';

export function sessionUpdateHandler(
    userId: string,
    socket: Socket,
    connection: ClientConnection,
): void {
    socket.on('update-metadata', async (data: unknown, callback?: (response: unknown) => void) => {
        try {
            const value = data && typeof data === 'object' && !Array.isArray(data)
                ? data as Record<string, unknown>
                : {};
            const sid = value.sid;
            const metadata = value.metadata;
            const expectedVersion = value.expectedVersion;
            if (
                typeof sid !== 'string'
                || typeof metadata !== 'string'
                || typeof expectedVersion !== 'number'
            ) {
                callback?.({ result: 'error' });
                return;
            }
            const accessWhere = sessionWriteWhereForConnection(userId, connection, sid);
            if (!accessWhere) {
                callback?.({ result: 'error' });
                return;
            }
            const session = await db.session.findFirst({ where: accessWhere });
            if (!session) {
                callback?.({ result: 'error' });
                return;
            }
            if (session.metadataVersion !== expectedVersion) {
                callback?.({
                    result: 'version-mismatch',
                    version: session.metadataVersion,
                    metadata: session.metadata,
                });
                return;
            }
            const { count } = await db.session.updateMany({
                where: { ...accessWhere, metadataVersion: expectedVersion },
                data: { metadata, metadataVersion: expectedVersion + 1 },
            });
            if (count === 0) {
                callback?.({
                    result: 'version-mismatch',
                    version: session.metadataVersion,
                    metadata: session.metadata,
                });
                return;
            }
            const updateSeq = await allocateUserSeq(userId);
            eventRouter.emitUpdate({
                userId,
                payload: buildUpdateSessionUpdate(
                    sid,
                    updateSeq,
                    randomKeyNaked(12),
                    { value: metadata, version: expectedVersion + 1 },
                ),
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
            });
            callback?.({
                result: 'success',
                version: expectedVersion + 1,
                metadata,
            });
        } catch {
            log({ module: 'websocket', level: 'error' }, 'Session metadata update failed');
            callback?.({ result: 'error' });
        }
    });
}
