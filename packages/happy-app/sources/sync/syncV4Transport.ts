import {
    SyncChangesResponseV4Schema,
    SyncMutationBatchResponseV4Schema,
    SyncMutationBatchV4Schema,
    SyncSnapshotRequiredV4Schema,
    SyncSnapshotResponseV4Schema,
    type SyncChangesResponseV4,
    type SyncMutationBatchResponseV4,
    type SyncMutationV4,
    type SyncSnapshotResponseV4,
} from '@slopus/happy-wire';
import { apiSocket } from './apiSocket';
import {
    AppSyncV4SnapshotRequiredError,
    type AppSyncV4Transport,
} from './syncV4Client';

export class HttpAppSyncV4Transport implements AppSyncV4Transport {
    async postMutations(sessionId: string, mutations: SyncMutationV4[]): Promise<SyncMutationBatchResponseV4> {
        const response = await apiSocket.request(
            `/v4/sessions/${encodeURIComponent(sessionId)}/mutations`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(SyncMutationBatchV4Schema.parse({ mutations })),
            },
        );
        if (!response.ok) throw new Error(`Sync v4 mutation request failed: ${response.status}`);
        return SyncMutationBatchResponseV4Schema.parse(await response.json());
    }

    async getChanges(sessionId: string, afterSeq: number, limit: number): Promise<SyncChangesResponseV4> {
        const response = await apiSocket.request(
            `/v4/sessions/${encodeURIComponent(sessionId)}/changes?after_seq=${afterSeq}&limit=${limit}`,
        );
        if (response.status === 410) {
            const required = SyncSnapshotRequiredV4Schema.parse(await response.json());
            throw new AppSyncV4SnapshotRequiredError(required.minimumSeq, required.highWatermark);
        }
        if (!response.ok) throw new Error(`Sync v4 changes request failed: ${response.status}`);
        return SyncChangesResponseV4Schema.parse(await response.json());
    }

    async getSnapshot(sessionId: string, cursor: string | null, limit: number): Promise<SyncSnapshotResponseV4> {
        const query = new URLSearchParams({ limit: String(limit) });
        if (cursor) query.set('cursor', cursor);
        const response = await apiSocket.request(
            `/v4/sessions/${encodeURIComponent(sessionId)}/snapshot?${query.toString()}`,
        );
        if (!response.ok) throw new Error(`Sync v4 snapshot request failed: ${response.status}`);
        return SyncSnapshotResponseV4Schema.parse(await response.json());
    }
}
