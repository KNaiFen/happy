import {
    SyncChangesResponseV4Schema,
    SyncMutationBatchResponseV4Schema,
    SyncMutationBatchV4Schema,
    SyncSnapshotRequiredV4Schema,
    SyncSnapshotResponseV4Schema,
    SyncV4CapabilitiesSchema,
    requireSyncV4TraceEcho,
    requireSyncV4TraceId,
    type SyncChangesResponseV4,
    type SyncMutationBatchResponseV4,
    type SyncMutationV4,
    type SyncSnapshotResponseV4,
    type SyncV4Capabilities,
} from '@slopus/happy-wire';
import {
    AppSyncV4SnapshotRequiredError,
    type AppSyncV4Transport,
} from './syncV4Client';

export type AppSyncV4HttpRequest = (
    path: string,
    init?: RequestInit,
) => Promise<Response>;

export class AppSyncV4HttpTransport implements AppSyncV4Transport {
    constructor(private readonly request: AppSyncV4HttpRequest) {}

    async getCapabilities(traceId?: string): Promise<SyncV4Capabilities> {
        const response = await this.request('/v4/capabilities', {
            headers: syncTraceHeaders(traceId),
        });
        validateTraceEcho(response, traceId);
        if (!response.ok) throw syncV4HttpError('capability', response.status);
        return SyncV4CapabilitiesSchema.parse(await response.json());
    }

    async postMutations(
        sessionId: string,
        mutations: SyncMutationV4[],
        traceId?: string,
    ): Promise<SyncMutationBatchResponseV4> {
        const response = await this.request(
            `/v4/sessions/${encodeURIComponent(sessionId)}/mutations`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...syncTraceHeaders(traceId),
                },
                body: JSON.stringify(SyncMutationBatchV4Schema.parse({ mutations })),
            },
        );
        validateTraceEcho(response, traceId);
        if (!response.ok) throw syncV4HttpError('mutation', response.status);
        return SyncMutationBatchResponseV4Schema.parse(await response.json());
    }

    async getChanges(
        sessionId: string,
        afterSeq: number,
        limit: number,
        traceId?: string,
    ): Promise<SyncChangesResponseV4> {
        const response = await this.request(
            `/v4/sessions/${encodeURIComponent(sessionId)}/changes?after_seq=${afterSeq}&limit=${limit}`,
            { headers: syncTraceHeaders(traceId) },
        );
        validateTraceEcho(response, traceId);
        if (response.status === 410) {
            const required = SyncSnapshotRequiredV4Schema.parse(await response.json());
            throw new AppSyncV4SnapshotRequiredError(required.minimumSeq, required.highWatermark);
        }
        if (!response.ok) throw syncV4HttpError('changes', response.status);
        return SyncChangesResponseV4Schema.parse(await response.json());
    }

    async getSnapshot(
        sessionId: string,
        cursor: string | null,
        limit: number,
        traceId?: string,
    ): Promise<SyncSnapshotResponseV4> {
        const query = new URLSearchParams({ limit: String(limit) });
        if (cursor) query.set('cursor', cursor);
        const response = await this.request(
            `/v4/sessions/${encodeURIComponent(sessionId)}/snapshot?${query.toString()}`,
            { headers: syncTraceHeaders(traceId) },
        );
        validateTraceEcho(response, traceId);
        if (!response.ok) throw syncV4HttpError('snapshot', response.status);
        return SyncSnapshotResponseV4Schema.parse(await response.json());
    }
}

function syncTraceHeaders(traceId?: string): Record<string, string> {
    return traceId ? { 'X-Happy-Sync-Trace': requireSyncV4TraceId(traceId) } : {};
}

function validateTraceEcho(response: Response, traceId?: string): void {
    requireSyncV4TraceEcho(traceId, response.headers.get('X-Happy-Sync-Trace'));
}

function syncV4HttpError(operation: string, statusCode: number): Error {
    return Object.assign(
        new Error(`Sync v4 ${operation} request failed with HTTP ${statusCode}`),
        { statusCode },
    );
}
