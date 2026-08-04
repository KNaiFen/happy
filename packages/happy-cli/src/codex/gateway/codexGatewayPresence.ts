import { randomUUID } from 'node:crypto';
import {
    SessionPresenceConflictError,
    type SessionPresenceConflictReason,
} from '@/api/api';

export interface CodexGatewayPresenceApi {
    claimSessionPresence(sessionId: string, leaseId: string, timeoutMs?: number): Promise<boolean>;
    touchSessionPresence(sessionId: string, leaseId: string, timeoutMs?: number): Promise<boolean>;
    releaseSessionPresence(sessionId: string, leaseId: string, timeoutMs?: number): Promise<boolean>;
}

export interface CodexGatewayPresenceLease {
    readonly sessionId: string;
    readonly leaseId: string;
    onTerminated(handler: (reason: SessionPresenceConflictReason) => Promise<void> | void): void;
    release(): Promise<void>;
}

export interface CodexGatewayPresenceRegistryContract {
    claim(sessionId: string): Promise<CodexGatewayPresenceLease | null>;
    terminateSession(sessionId: string, reason: SessionPresenceConflictReason): Promise<void>;
}

export class CodexGatewayArchivedSessionError extends Error {
    readonly name = 'CodexGatewayArchivedSessionError';

    constructor(readonly sessionId: string) {
        super('Codex Gateway cannot materialize an archived Happy session');
    }
}

interface PresenceEntry {
    leaseId: string;
    onTerminated: ((reason: SessionPresenceConflictReason) => Promise<void> | void) | null;
}

export class CodexGatewayPresenceRegistry implements CodexGatewayPresenceRegistryContract {
    private readonly entries = new Map<string, PresenceEntry>();
    private readonly terminatedSessionIds = new Set<string>();
    private touchPromise: Promise<void> | null = null;

    constructor(private readonly options: {
        api: CodexGatewayPresenceApi;
        requestTimeoutMs?: number;
        onError?: (error: unknown) => void;
    }) {}

    async claim(sessionId: string): Promise<CodexGatewayPresenceLease | null> {
        if (this.terminatedSessionIds.has(sessionId)) {
            throw new SessionPresenceConflictError('presenceLeaseSuperseded');
        }
        const leaseId = randomUUID();
        const claimed = await this.options.api.claimSessionPresence(
            sessionId,
            leaseId,
            this.options.requestTimeoutMs,
        );
        if (!claimed) return null;

        const entry: PresenceEntry = { leaseId, onTerminated: null };
        this.entries.set(sessionId, entry);
        return {
            sessionId,
            leaseId,
            onTerminated: (handler) => {
                if (this.entries.get(sessionId) === entry) entry.onTerminated = handler;
            },
            release: async () => {
                await this.release(sessionId, entry);
            },
        };
    }

    touchAll(): Promise<void> {
        if (!this.touchPromise) {
            const current = this.touchAllOnce();
            this.touchPromise = current;
            void current.finally(() => {
                if (this.touchPromise === current) this.touchPromise = null;
            });
        }
        return this.touchPromise;
    }

    async reconcile(sessionId: string): Promise<boolean> {
        const entry = this.entries.get(sessionId);
        if (!entry) return false;
        try {
            return await this.options.api.claimSessionPresence(
                sessionId,
                entry.leaseId,
                this.options.requestTimeoutMs,
            );
        } catch (error) {
            if (error instanceof SessionPresenceConflictError) {
                await this.terminate(sessionId, entry, error.reason);
                return false;
            }
            throw error;
        }
    }

    async terminateSession(
        sessionId: string,
        reason: SessionPresenceConflictReason,
    ): Promise<void> {
        const entry = this.entries.get(sessionId);
        if (!entry) return;
        await this.terminate(sessionId, entry, reason);
    }

    async releaseAll(): Promise<void> {
        const results = await Promise.allSettled(
            [...this.entries].map(([sessionId, entry]) => this.release(sessionId, entry)),
        );
        const failed = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failed) throw failed.reason;
    }

    private async touchAllOnce(): Promise<void> {
        await Promise.all([...this.entries].map(async ([sessionId, entry]) => {
            try {
                await this.options.api.touchSessionPresence(
                    sessionId,
                    entry.leaseId,
                    this.options.requestTimeoutMs,
                );
            } catch (error) {
                if (error instanceof SessionPresenceConflictError) {
                    await this.terminate(sessionId, entry, error.reason);
                    return;
                }
                this.options.onError?.(error);
            }
        }));
    }

    private async release(sessionId: string, entry: PresenceEntry): Promise<void> {
        if (this.entries.get(sessionId) !== entry) return;
        // A closing binding must never keep renewing a lease when the relay is down.
        // The server-side timeout then transitions the stale presence to recoverable history.
        this.entries.delete(sessionId);
        try {
            const released = await this.options.api.releaseSessionPresence(
                sessionId,
                entry.leaseId,
                this.options.requestTimeoutMs,
            );
            if (!released) {
                this.options.onError?.(new Error('Session presence release is pending relay recovery'));
            }
        } catch (error) {
            if (error instanceof SessionPresenceConflictError) {
                this.terminatedSessionIds.add(sessionId);
                return;
            }
            this.options.onError?.(error);
        }
    }

    private async terminate(
        sessionId: string,
        entry: PresenceEntry,
        reason: SessionPresenceConflictReason,
    ): Promise<void> {
        if (this.entries.get(sessionId) !== entry) return;
        this.entries.delete(sessionId);
        this.terminatedSessionIds.add(sessionId);
        try {
            const result = entry.onTerminated?.(reason);
            void Promise.resolve(result).catch((error) => this.options.onError?.(error));
        } catch (error) {
            this.options.onError?.(error);
        }
    }
}
