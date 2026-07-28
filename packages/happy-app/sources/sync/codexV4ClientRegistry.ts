export interface CodexV4RegistryClient {
    start(): Promise<void>;
    stop(): void;
    invalidate(highWatermark?: number): void;
}

export interface CodexV4RegistrySession {
    sessionId: string;
    sessionKey: Uint8Array;
}

export function isCodexV4SyncEligible(metadata: {
    flavor?: string | null;
    codexSyncVersion?: number;
} | null | undefined): boolean {
    return metadata?.flavor === 'codex' && metadata.codexSyncVersion === 4;
}

export function isCodexV4SyncActive<TProjection extends { activated?: boolean }>(
    metadata: Parameters<typeof isCodexV4SyncEligible>[0],
    projection: TProjection | null | undefined,
): projection is TProjection & { activated: true } {
    return isCodexV4SyncEligible(metadata) && projection?.activated === true;
}

interface CodexV4ClientFactoryOptions<TEvent> extends CodexV4RegistrySession {
    onEntity: (event: TEvent) => Promise<void>;
    onEntities: (events: readonly TEvent[]) => Promise<void>;
    onSnapshotReset: () => Promise<void>;
}

interface CodexV4ClientRegistryOptions<TClient extends CodexV4RegistryClient, TEvent> {
    createClient: (options: CodexV4ClientFactoryOptions<TEvent>) => Promise<TClient>;
    isEligible: (sessionId: string) => boolean;
    onEntity: (sessionId: string, event: TEvent) => Promise<void>;
    onEntities?: (sessionId: string, events: readonly TEvent[]) => Promise<void>;
    onSnapshotReset: (sessionId: string) => Promise<void>;
    onStartError?: (sessionId: string) => void;
}

interface StartingClient<TClient extends CodexV4RegistryClient> {
    generation: number;
    client: TClient | null;
    created: Promise<TClient>;
    promise: Promise<void>;
}

export class CodexV4ClientRegistry<TClient extends CodexV4RegistryClient, TEvent> {
    private readonly clients = new Map<string, TClient>();
    private readonly starts = new Map<string, StartingClient<TClient>>();
    private readonly generations = new Map<string, number>();

    constructor(private readonly options: CodexV4ClientRegistryOptions<TClient, TEvent>) {}

    reconcile(sessions: CodexV4RegistrySession[]): void {
        const desired = new Map(sessions.map((session) => [session.sessionId, session]));
        const knownSessionIds = new Set([...this.clients.keys(), ...this.starts.keys()]);
        for (const sessionId of knownSessionIds) {
            if (!desired.has(sessionId)) this.stop(sessionId);
        }
        for (const session of desired.values()) {
            if (this.clients.has(session.sessionId) || this.starts.has(session.sessionId)) continue;
            this.start(session);
        }
    }

    invalidate(sessionId: string, highWatermark?: number): void {
        this.clients.get(sessionId)?.invalidate(highWatermark);
    }

    invalidateAll(): void {
        for (const client of this.clients.values()) client.invalidate();
    }

    stop(sessionId: string): void {
        this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
        const activeClient = this.clients.get(sessionId);
        const startingClient = this.starts.get(sessionId)?.client;
        activeClient?.stop();
        this.clients.delete(sessionId);
        if (startingClient && startingClient !== activeClient) startingClient.stop();
        this.starts.delete(sessionId);
    }

    hasClient(sessionId: string): boolean {
        return this.clients.has(sessionId);
    }

    hasStartingClient(sessionId: string): boolean {
        return this.starts.has(sessionId);
    }

    async withClient<TResult>(sessionId: string, operation: (client: TClient) => Promise<TResult>): Promise<TResult> {
        const active = this.clients.get(sessionId);
        if (active) return await operation(active);

        const starting = this.starts.get(sessionId);
        if (!starting) throw new Error('Codex Sync v4 client is not available');
        const client = starting.client ?? await starting.created;
        if (
            this.generations.get(sessionId) !== starting.generation
            || !this.options.isEligible(sessionId)
        ) {
            throw new Error('Codex Sync v4 client is no longer eligible');
        }
        return await operation(client);
    }

    private start(session: CodexV4RegistrySession): void {
        const generation = (this.generations.get(session.sessionId) ?? 0) + 1;
        this.generations.set(session.sessionId, generation);
        let record!: StartingClient<TClient>;
        const isCurrent = () => (
            this.generations.get(session.sessionId) === generation
            && (this.starts.get(session.sessionId) === record || this.clients.get(session.sessionId) === record.client)
        );
        const created = this.options.createClient({
            ...session,
            onEntity: async (event) => {
                if (!isCurrent() || !this.options.isEligible(session.sessionId)) return;
                await this.options.onEntity(session.sessionId, event);
            },
            onEntities: async (events) => {
                if (!isCurrent() || !this.options.isEligible(session.sessionId)) return;
                if (this.options.onEntities) {
                    await this.options.onEntities(session.sessionId, events);
                    return;
                }
                for (const event of events) {
                    if (!isCurrent() || !this.options.isEligible(session.sessionId)) return;
                    await this.options.onEntity(session.sessionId, event);
                }
            },
            onSnapshotReset: async () => {
                if (!isCurrent() || !this.options.isEligible(session.sessionId)) return;
                await this.options.onSnapshotReset(session.sessionId);
            },
        });
        record = {
            generation,
            client: null,
            created,
            promise: Promise.resolve(),
        };
        this.starts.set(session.sessionId, record);
        record.promise = (async () => {
            try {
                const client = await created;
                record.client = client;
                if (!isCurrent() || !this.options.isEligible(session.sessionId)) {
                    client.stop();
                    return;
                }
                await client.start();
                if (!isCurrent() || !this.options.isEligible(session.sessionId)) {
                    client.stop();
                    return;
                }
                this.clients.set(session.sessionId, client);
            } catch {
                record.client?.stop();
                if (isCurrent()) this.options.onStartError?.(session.sessionId);
            } finally {
                if (this.starts.get(session.sessionId) === record) this.starts.delete(session.sessionId);
            }
        })();
        void record.promise;
    }
}
