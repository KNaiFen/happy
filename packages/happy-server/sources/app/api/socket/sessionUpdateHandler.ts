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
import { afterTx, inTx } from '@/storage/inTx';
import { acquireAccountWrite } from '@/app/account/accountWriteGate';

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
            const result = await inTx(async (tx) => {
                if (!await acquireAccountWrite(tx, userId)) return { kind: 'missing' as const };
                const session = await tx.session.findFirst({ where: accessWhere });
                if (!session) return { kind: 'missing' as const };
                if (session.metadataVersion !== expectedVersion) return { kind: 'version-mismatch' as const, session };
                const updated = await tx.session.updateMany({ where: { ...accessWhere, metadataVersion: expectedVersion }, data: { metadata, metadataVersion: expectedVersion + 1 } });
                if (updated.count !== 1) return { kind: 'version-mismatch' as const, session };
                const updateSeq = await allocateUserSeq(userId, tx);
                const payload = buildUpdateSessionUpdate(sid, updateSeq, randomKeyNaked(12), { value: metadata, version: expectedVersion + 1 });
                afterTx(tx, () => eventRouter.emitUpdate({ userId, payload, recipientFilter: { type: 'all-interested-in-session', sessionId: sid } }));
                return { kind: 'updated' as const };
            });
            if (result.kind === 'missing') { callback?.({ result: 'error' }); return; }
            if (result.kind === 'version-mismatch') {
                callback?.({ result: 'version-mismatch', version: result.session.metadataVersion, metadata: result.session.metadata });
                return;
            }
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
