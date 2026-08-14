import {
    classifySyncV4DiagnosticError,
    recordSyncV4DiagnosticSafely,
    type SyncV4DiagnosticInput,
    type SyncV4DiagnosticSink,
    type SyncV4DiagnosticTransportSecurity,
} from '@slopus/happy-wire';
import {
    appSyncV4DiagnosticStatsAreDegraded,
    readAppSyncV4DiagnosticStatsSafely,
    type AppSyncV4DiagnosticStatsProvider,
} from './syncV4Diagnostics';

const MAX_PENDING_ON_DEMAND_STARTS = 256;

export interface CodexV4RegistryClient {
    readonly diagnosticSessionId?: string;
    start(): Promise<void>;
    stop(options?: { silent?: boolean }): void;
    invalidate(highWatermark?: number): void;
}

export interface CodexV4RegistrySession {
    sessionId: string;
    sessionKey: Uint8Array;
    machineId?: string | null;
    pollIntervalMs?: number | null;
}

export interface CodexV4RegistrySyncState {
    type: 'starting' | 'retrying' | 'ready' | 'unknown';
    attempt: number;
    nextRetryAt: number | null;
    lastErrorAt: number | null;
}

export function isCodexV4SyncEligible(metadata: {
    flavor?: string | null;
    codexSyncVersion?: number;
} | null | undefined): boolean {
    return metadata?.flavor === 'codex' && metadata.codexSyncVersion === 4;
}

export function codexV4PollIntervalMsForLifecycle(lifecycle: {
    active: boolean;
    archivedAt?: number | null;
}): number | null {
    return lifecycle.active && lifecycle.archivedAt == null ? 5_000 : null;
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
    onSnapshotReplace?: (events: readonly TEvent[]) => Promise<void>;
}

interface CodexV4ClientRegistryOptions<TClient extends CodexV4RegistryClient, TEvent> {
    createClient: (options: CodexV4ClientFactoryOptions<TEvent>) => Promise<TClient>;
    isEligible: (sessionId: string) => boolean;
    onEntity: (sessionId: string, event: TEvent) => Promise<void>;
    onEntities?: (sessionId: string, events: readonly TEvent[]) => Promise<void>;
    onSnapshotReset: (sessionId: string) => Promise<void>;
    onSnapshotReplace?: (sessionId: string, events: readonly TEvent[]) => Promise<void>;
    onStartError?: (sessionId: string, error: unknown) => void;
    onSyncState?: (sessionId: string, state: CodexV4RegistrySyncState) => void;
    diagnostics?: SyncV4DiagnosticSink;
    diagnosticStats?: AppSyncV4DiagnosticStatsProvider;
    softwareVersion?: string;
    transportSecurity?: SyncV4DiagnosticTransportSecurity;
    retryBaseMs?: number;
    retryMaxMs?: number;
    random?: () => number;
}

interface StartingClient<TClient extends CodexV4RegistryClient> {
    generation: number;
    client: TClient | null;
    stopped: boolean;
    silent: boolean;
    sessionKey: Uint8Array;
    created: Promise<TClient>;
    promise: Promise<void>;
}

export class CodexV4ClientRegistry<TClient extends CodexV4RegistryClient, TEvent> {
    private readonly clients = new Map<string, TClient>();
    private readonly starts = new Map<string, StartingClient<TClient>>();
    private readonly generations = new Map<string, number>();
    private readonly desired = new Map<string, CodexV4RegistrySession>();
    private readonly pendingStarts = new Set<string>();
    private readonly retryAttempts = new Map<string, number>();
    private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly options: CodexV4ClientRegistryOptions<TClient, TEvent>) {}

    reconcile(sessions: CodexV4RegistrySession[]): void {
        const desired = new Map(sessions.map((session) => [session.sessionId, {
            ...session,
            sessionKey: session.sessionKey.slice(),
        }]));
        const knownSessionIds = new Set([
            ...this.desired.keys(),
            ...this.clients.keys(),
            ...this.starts.keys(),
            ...this.retryTimers.keys(),
        ]);
        for (const sessionId of knownSessionIds) {
            if (!desired.has(sessionId)) this.stop(sessionId);
        }
        for (const session of desired.values()) {
            const pendingStart = this.pendingStarts.delete(session.sessionId);
            const previous = this.desired.get(session.sessionId);
            if (previous && previous.pollIntervalMs !== session.pollIntervalMs) {
                this.stop(session.sessionId);
            }
            const previousDesired = this.desired.get(session.sessionId);
            if (previousDesired && previousDesired !== session) previousDesired.sessionKey.fill(0);
            this.desired.set(session.sessionId, session);
            if (session.pollIntervalMs === null && !pendingStart) continue;
            if (
                this.clients.has(session.sessionId)
                || this.starts.has(session.sessionId)
                || this.retryTimers.has(session.sessionId)
            ) continue;
            this.start(session, false);
        }
    }

    invalidate(sessionId: string, highWatermark?: number): void {
        const client = this.clients.get(sessionId);
        if (client) {
            client.invalidate(highWatermark);
            return;
        }
        if (!this.desired.has(sessionId)) {
            if (
                !this.pendingStarts.has(sessionId)
                && this.pendingStarts.size >= MAX_PENDING_ON_DEMAND_STARTS
            ) {
                this.pendingStarts.delete(this.pendingStarts.values().next().value!);
            }
            this.pendingStarts.add(sessionId);
            return;
        }
        this.wakeRetry(sessionId);
    }

    invalidateAll(): void {
        const sessionIds = new Set(this.clients.keys());
        for (const [sessionId, session] of this.desired) {
            if (session.pollIntervalMs !== null) sessionIds.add(sessionId);
        }
        for (const sessionId of sessionIds) this.invalidate(sessionId);
    }

    stop(sessionId: string, options?: { silent?: boolean }): void {
        const silent = options?.silent === true;
        const desiredSession = this.desired.get(sessionId);
        const diagnosticStats = readAppSyncV4DiagnosticStatsSafely(this.options.diagnosticStats);
        const diagnosticsDegraded = appSyncV4DiagnosticStatsAreDegraded(diagnosticStats);
        if (!silent) {
            this.recordDiagnostic(sessionId, {
                level: diagnosticsDegraded ? 'warn' : 'info',
                event: 'lifecycle',
                phase: diagnosticsDegraded ? 'failed' : 'completed',
                state: diagnosticsDegraded ? 'degraded' : 'stopped',
                count: diagnosticStats?.count,
                dropped: diagnosticStats?.droppedRecords,
                invalid: diagnosticStats?.invalidRecords,
                writeFailures: diagnosticStats?.writeFailures,
                listenerFailures: diagnosticStats?.listenerFailures,
            });
        }
        this.desired.delete(sessionId);
        this.pendingStarts.delete(sessionId);
        this.retryAttempts.delete(sessionId);
        const retryTimer = this.retryTimers.get(sessionId);
        if (retryTimer) clearTimeout(retryTimer);
        this.retryTimers.delete(sessionId);
        this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
        const activeClient = this.clients.get(sessionId);
        const startingRecord = this.starts.get(sessionId);
        const startingClient = startingRecord?.client;
        desiredSession?.sessionKey.fill(0);
        if (startingRecord) startingRecord.silent = silent;
        activeClient?.stop({ silent });
        this.clients.delete(sessionId);
        if (startingClient && startingClient !== activeClient && !startingRecord?.stopped) {
            startingRecord!.silent = silent;
            startingClient.stop({ silent });
            startingRecord!.stopped = true;
        }
        // The factory may still be awaiting native crypto setup. Clear its
        // private copy immediately; the create() finally block repeats this
        // operation when the promise eventually settles.
        startingRecord?.sessionKey.fill(0);
        this.starts.delete(sessionId);
    }

    stopAll(options?: { silent?: boolean }): void {
        const sessionIds = new Set([
            ...this.desired.keys(),
            ...this.clients.keys(),
            ...this.starts.keys(),
            ...this.retryAttempts.keys(),
            ...this.retryTimers.keys(),
        ]);
        for (const sessionId of sessionIds) this.stop(sessionId, options);
        this.pendingStarts.clear();
        this.generations.clear();
    }

    hasClient(sessionId: string): boolean {
        return this.clients.has(sessionId);
    }

    hasStartingClient(sessionId: string): boolean {
        return this.starts.has(sessionId);
    }

    async withClient<TResult>(sessionId: string, operation: (client: TClient) => Promise<TResult>): Promise<TResult> {
        const active = this.clients.get(sessionId);
        if (active) {
            if (!this.options.isEligible(sessionId)) {
                this.stop(sessionId);
                throw new Error('Codex Sync v4 client is no longer eligible');
            }
            return await operation(active);
        }

        let starting = this.starts.get(sessionId);
        if (!starting && this.desired.has(sessionId)) {
            if (!this.options.isEligible(sessionId)) {
                this.stop(sessionId);
                throw new Error('Codex Sync v4 client is no longer eligible');
            }
            this.wakeRetry(sessionId);
            starting = this.starts.get(sessionId);
        }
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

    private start(session: CodexV4RegistrySession, retrying: boolean): void {
        const generation = (this.generations.get(session.sessionId) ?? 0) + 1;
        this.generations.set(session.sessionId, generation);
        const attempt = this.retryAttempts.get(session.sessionId) ?? 0;
        this.emitSyncState(session.sessionId, {
            type: retrying ? 'retrying' : 'starting',
            attempt,
            nextRetryAt: null,
            lastErrorAt: null,
        });
        this.recordDiagnostic(session.sessionId, {
            level: 'info',
            event: 'lifecycle',
            phase: 'started',
            state: retrying ? 'retrying' : 'starting',
            attempt,
            generation,
        });
        let record!: StartingClient<TClient>;
        const isCurrent = () => (
            this.generations.get(session.sessionId) === generation
            && (this.starts.get(session.sessionId) === record || this.clients.get(session.sessionId) === record.client)
        );
        const factorySessionKey = session.sessionKey.slice();
        const created = this.options.createClient({
            ...session,
            sessionKey: factorySessionKey,
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
            onSnapshotReplace: this.options.onSnapshotReplace
                ? async (events) => {
                    if (!isCurrent() || !this.options.isEligible(session.sessionId)) return;
                    await this.options.onSnapshotReplace!(session.sessionId, events);
                }
                : undefined,
        });
        record = {
            generation,
            client: null,
            stopped: false,
            silent: false,
            sessionKey: factorySessionKey,
            created,
            promise: Promise.resolve(),
        };
        this.starts.set(session.sessionId, record);
        record.promise = (async () => {
            try {
                let client: TClient;
                try {
                    client = await created;
                } finally {
                    factorySessionKey.fill(0);
                }
                record.client = client;
                if (!isCurrent() || !this.options.isEligible(session.sessionId)) {
                    if (!record.stopped) {
                        client.stop({ silent: record.silent });
                        record.stopped = true;
                    }
                    return;
                }
                await client.start();
                if (!isCurrent() || !this.options.isEligible(session.sessionId)) {
                    if (!record.stopped) {
                        client.stop();
                        record.stopped = true;
                    }
                    return;
                }
                this.clients.set(session.sessionId, client);
                this.retryAttempts.delete(session.sessionId);
                this.emitSyncState(session.sessionId, {
                    type: 'ready',
                    attempt: 0,
                    nextRetryAt: null,
                    lastErrorAt: null,
                });
                this.recordDiagnostic(session.sessionId, {
                    level: 'info',
                    event: 'lifecycle',
                    phase: 'completed',
                    state: 'ready',
                    attempt: 0,
                    generation,
                });
            } catch (error) {
                if (record.client && !record.stopped) {
                    record.client.stop({ silent: record.silent });
                    record.stopped = true;
                }
                if (isCurrent()) {
                    this.recordDiagnostic(session.sessionId, {
                        level: 'warn',
                        event: 'lifecycle',
                        phase: 'failed',
                        state: 'unknown',
                        errorKind: classifySyncV4DiagnosticError(error),
                        attempt,
                        generation,
                    });
                    this.options.onStartError?.(session.sessionId, error);
                    const desired = this.desired.get(session.sessionId);
                    if (desired?.pollIntervalMs === null) {
                        this.deferRetryUntilInvalidated(session.sessionId);
                    } else {
                        this.scheduleRetry(session.sessionId);
                    }
                }
            } finally {
                if (this.starts.get(session.sessionId) === record) this.starts.delete(session.sessionId);
            }
        })();
        void record.promise;
    }

    private scheduleRetry(sessionId: string): void {
        const desired = this.desired.get(sessionId);
        if (!desired || desired.pollIntervalMs === null || !this.options.isEligible(sessionId)) return;
        const attempt = (this.retryAttempts.get(sessionId) ?? 0) + 1;
        this.retryAttempts.set(sessionId, attempt);
        const base = this.options.retryBaseMs ?? 1_000;
        const maximum = this.options.retryMaxMs ?? 60_000;
        const exponential = Math.min(maximum, base * (2 ** Math.min(attempt - 1, 20)));
        const jitter = 0.8 + (this.options.random ?? Math.random)() * 0.4;
        const delay = Math.max(1, Math.round(exponential * jitter));
        const nextRetryAt = Date.now() + delay;
        this.emitSyncState(sessionId, {
            type: 'unknown',
            attempt,
            nextRetryAt,
            lastErrorAt: Date.now(),
        });
        this.recordDiagnostic(sessionId, {
            level: 'warn',
            event: 'retry',
            phase: 'scheduled',
            state: 'unknown',
            attempt,
            durationMs: delay,
        });
        const timer = setTimeout(() => {
            if (this.retryTimers.get(sessionId) !== timer) return;
            this.retryTimers.delete(sessionId);
            const latestDesired = this.desired.get(sessionId);
            if (
                !latestDesired
                || latestDesired.pollIntervalMs === null
                || !this.options.isEligible(sessionId)
            ) return;
            if (this.clients.has(sessionId) || this.starts.has(sessionId)) return;
            this.start(latestDesired, true);
        }, delay);
        this.retryTimers.set(sessionId, timer);
    }

    private deferRetryUntilInvalidated(sessionId: string): void {
        const attempt = (this.retryAttempts.get(sessionId) ?? 0) + 1;
        this.retryAttempts.set(sessionId, attempt);
        this.emitSyncState(sessionId, {
            type: 'unknown',
            attempt,
            nextRetryAt: null,
            lastErrorAt: Date.now(),
        });
    }

    private wakeRetry(sessionId: string): void {
        const timer = this.retryTimers.get(sessionId);
        if (timer) clearTimeout(timer);
        this.retryTimers.delete(sessionId);
        const desired = this.desired.get(sessionId);
        if (
            !desired
            || !this.options.isEligible(sessionId)
            || this.clients.has(sessionId)
            || this.starts.has(sessionId)
        ) return;
        this.start(desired, this.retryAttempts.has(sessionId));
    }

    private emitSyncState(sessionId: string, state: CodexV4RegistrySyncState): void {
        this.options.onSyncState?.(sessionId, state);
    }

    private recordDiagnostic(
        sessionId: string,
        input: Omit<SyncV4DiagnosticInput, 'component' | 'protocolVersion' | 'sessionHash' | 'softwareVersion'>,
    ): void {
        const client = this.clients.get(sessionId) ?? this.starts.get(sessionId)?.client;
        recordSyncV4DiagnosticSafely(this.options.diagnostics, {
            component: 'app.registry',
            protocolVersion: 4,
            softwareVersion: this.options.softwareVersion,
            sessionHash: client?.diagnosticSessionId,
            featureEnabled: true,
            transportSecurity: this.options.transportSecurity ?? 'https',
            ...input,
        });
    }
}
