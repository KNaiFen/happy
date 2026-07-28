import type { Thread, ThreadStatus, Turn, TurnStatus } from './protocol';

export interface CodexTurnCompletion {
    threadId: string;
    turnId: string | null;
    status: TurnStatus;
    aborted: boolean;
    source: 'turn' | 'threadStatus' | 'snapshot';
}

export interface CodexTurnWaitHandle {
    readonly threadId: string;
    readonly promise: Promise<CodexTurnCompletion>;
}

export interface CodexTurnRuntime {
    readonly turnId: string;
    snapshot: Turn | null;
    status: TurnStatus;
    completion: Promise<CodexTurnCompletion> | null;
    settled: boolean;
}

export interface CodexThreadRuntime {
    readonly threadId: string;
    snapshot: Thread | null;
    status: ThreadStatus;
    placeholder: boolean;
    hydrationRequested: boolean;
    activeTurnId: string | null;
    turns: Map<string, CodexTurnRuntime>;
}

interface CompletionController {
    readonly promise: Promise<CodexTurnCompletion>;
    resolve: (completion: CodexTurnCompletion) => void;
    reject: (error: Error) => void;
    settled: boolean;
}

interface PendingTurnStart {
    readonly controller: CompletionController;
    readonly knownTurnIds: Set<string>;
    turnId: string | null;
}

export class CodexThreadRegistry {
    private readonly threads = new Map<string, CodexThreadRuntime>();
    private readonly pendingStarts = new Map<string, PendingTurnStart>();
    private readonly turnCompletions = new Map<string, CompletionController>();
    private selectedThreadId: string | null = null;

    get selectedThread(): CodexThreadRuntime | null {
        return this.selectedThreadId ? this.threads.get(this.selectedThreadId) ?? null : null;
    }

    get selectedThreadIdValue(): string | null {
        return this.selectedThreadId;
    }

    get selectedTurnId(): string | null {
        return this.selectedThread?.activeTurnId ?? null;
    }

    activeThreadIds(): string[] {
        const active: string[] = [];
        for (const [threadId, runtime] of this.threads) {
            const turn = runtime.activeTurnId
                ? runtime.turns.get(runtime.activeTurnId)
                : null;
            if (
                this.pendingStarts.has(threadId)
                || runtime.status.type === 'active'
                || (turn?.status === 'inProgress' && !turn.settled)
            ) {
                active.push(threadId);
            }
        }
        return active;
    }

    pendingCompletion(threadId: string): Promise<CodexTurnCompletion> | null {
        const pending = this.pendingStarts.get(threadId);
        if (pending) return pending.controller.promise;
        const runtime = this.threads.get(threadId);
        if (!runtime?.activeTurnId) return null;
        return this.turnCompletions.get(turnKey(threadId, runtime.activeTurnId))?.promise
            ?? runtime.turns.get(runtime.activeTurnId)?.completion
            ?? null;
    }

    selectThread(threadId: string): CodexThreadRuntime {
        const { runtime } = this.ensureThread(threadId);
        this.selectedThreadId = threadId;
        return runtime;
    }

    clearSelection(): void {
        this.selectedThreadId = null;
    }

    clear(error: Error): void {
        this.shutdown(error);
        this.threads.clear();
        this.selectedThreadId = null;
    }

    forgetThread(threadId: string, error: Error): void {
        const pending = this.pendingStarts.get(threadId);
        if (pending) pending.controller.reject(error);
        this.pendingStarts.delete(threadId);
        for (const [key, completion] of this.turnCompletions) {
            if (!key.startsWith(`${threadId}\0`)) continue;
            completion.reject(error);
            this.turnCompletions.delete(key);
        }
        this.threads.delete(threadId);
        if (this.selectedThreadId === threadId) this.selectedThreadId = null;
    }

    ensureThread(threadId: string): { runtime: CodexThreadRuntime; created: boolean } {
        const existing = this.threads.get(threadId);
        if (existing) return { runtime: existing, created: false };
        const runtime: CodexThreadRuntime = {
            threadId,
            snapshot: null,
            status: { type: 'notLoaded' },
            placeholder: true,
            hydrationRequested: false,
            activeTurnId: null,
            turns: new Map(),
        };
        this.threads.set(threadId, runtime);
        return { runtime, created: true };
    }

    getThread(threadId: string): CodexThreadRuntime | null {
        return this.threads.get(threadId) ?? null;
    }

    registerThread(thread: Thread, source: 'response' | 'snapshot' = 'response'): CodexThreadRuntime {
        const { runtime } = this.ensureThread(thread.id);
        runtime.placeholder = false;
        runtime.hydrationRequested = true;

        const previousUpdatedAt = typeof runtime.snapshot?.updatedAt === 'number'
            ? runtime.snapshot.updatedAt
            : Number.NEGATIVE_INFINITY;
        const incomingUpdatedAt = typeof thread.updatedAt === 'number'
            ? thread.updatedAt
            : previousUpdatedAt;
        if (
            source === 'snapshot'
            && runtime.snapshot
            && incomingUpdatedAt < previousUpdatedAt
        ) {
            return runtime;
        }

        for (const turn of thread.turns) {
            this.registerTurn(thread.id, turn, source === 'snapshot' ? 'snapshot' : 'turn');
        }
        runtime.snapshot = thread;
        runtime.status = thread.status;
        if (thread.status.type !== 'active') {
            this.settleFromThreadStatus(runtime, source === 'snapshot' ? 'snapshot' : 'threadStatus');
        }
        return runtime;
    }

    markHydrationRequested(threadId: string): boolean {
        const { runtime } = this.ensureThread(threadId);
        if (runtime.hydrationRequested) return false;
        runtime.hydrationRequested = true;
        return true;
    }

    markHydrationFailed(threadId: string): void {
        const runtime = this.threads.get(threadId);
        if (runtime?.placeholder) runtime.hydrationRequested = false;
    }

    updateThreadStatus(threadId: string, status: ThreadStatus): CodexThreadRuntime {
        const { runtime } = this.ensureThread(threadId);
        runtime.status = status;
        if (runtime.snapshot) runtime.snapshot = { ...runtime.snapshot, status };
        if (status.type !== 'active') this.settleFromThreadStatus(runtime, 'threadStatus');
        return runtime;
    }

    beginTurn(threadId: string): CodexTurnWaitHandle {
        const runtime = this.ensureThread(threadId).runtime;
        const existing = this.pendingStarts.get(threadId);
        if (existing && !existing.controller.settled) {
            throw new Error('A turn start is already pending for this thread');
        }
        if (runtime.activeTurnId) {
            const active = runtime.turns.get(runtime.activeTurnId);
            if (active && active.status === 'inProgress' && !active.settled) {
                throw new Error('This thread already has an active turn');
            }
        }

        const controller = createCompletionController();
        const handle: CodexTurnWaitHandle = { threadId, promise: controller.promise };
        this.pendingStarts.set(threadId, {
            controller,
            knownTurnIds: new Set(runtime.turns.keys()),
            turnId: null,
        });
        return handle;
    }

    failTurnStart(threadId: string, error: Error): void {
        const pending = this.pendingStarts.get(threadId);
        if (!pending) return;
        this.pendingStarts.delete(threadId);
        pending.controller.reject(error);
    }

    registerTurn(
        threadId: string,
        turn: Turn,
        source: CodexTurnCompletion['source'] = 'turn',
    ): CodexTurnRuntime {
        const thread = this.ensureThread(threadId).runtime;
        let runtime = thread.turns.get(turn.id);
        if (!runtime) {
            runtime = {
                turnId: turn.id,
                snapshot: turn,
                status: turn.status,
                completion: null,
                settled: false,
            };
            thread.turns.set(turn.id, runtime);
        } else {
            if (isTerminalTurnStatus(runtime.status)) {
                runtime.snapshot = {
                    ...turn,
                    status: runtime.status,
                    error: runtime.snapshot?.error ?? turn.error,
                    completedAt: runtime.snapshot?.completedAt ?? turn.completedAt,
                    durationMs: runtime.snapshot?.durationMs ?? turn.durationMs,
                };
            } else {
                runtime.snapshot = turn;
                runtime.status = turn.status;
            }
        }

        const pending = this.pendingStarts.get(threadId);
        if (pending && (
            pending.turnId === turn.id
            || (pending.turnId === null && !pending.knownTurnIds.has(turn.id))
        )) {
            pending.turnId = turn.id;
            this.pendingStarts.delete(threadId);
            this.turnCompletions.set(turnKey(threadId, turn.id), pending.controller);
            runtime.completion = pending.controller.promise;
        }

        if (runtime.status === 'inProgress') {
            const activeTurn = thread.activeTurnId
                ? thread.turns.get(thread.activeTurnId)
                : null;
            if (
                !activeTurn
                || activeTurn.turnId === turn.id
                || isTurnNewer(runtime, activeTurn)
            ) {
                thread.activeTurnId = turn.id;
            }
        } else {
            this.settleTurn(thread, runtime, source);
        }
        return runtime;
    }

    hasPendingTurn(threadId: string): boolean {
        if (this.pendingStarts.has(threadId)) return true;
        const runtime = this.threads.get(threadId);
        if (!runtime?.activeTurnId) return false;
        const turn = runtime.turns.get(runtime.activeTurnId);
        return !!turn && !turn.settled && turn.status === 'inProgress';
    }

    shutdown(error: Error): void {
        for (const pending of this.pendingStarts.values()) pending.controller.reject(error);
        for (const completion of this.turnCompletions.values()) completion.reject(error);
        this.pendingStarts.clear();
        this.turnCompletions.clear();
    }

    private settleFromThreadStatus(
        thread: CodexThreadRuntime,
        source: 'threadStatus' | 'snapshot',
    ): void {
        if (!thread.activeTurnId) {
            const pending = this.pendingStarts.get(thread.threadId);
            if (!pending || source !== 'threadStatus') return;
            this.pendingStarts.delete(thread.threadId);
            pending.controller.resolve({
                threadId: thread.threadId,
                turnId: null,
                status: thread.status.type === 'systemError' ? 'failed' : 'completed',
                aborted: false,
                source,
            });
            return;
        }
        const turn = thread.turns.get(thread.activeTurnId);
        if (!turn || turn.settled) return;
        turn.status = thread.status.type === 'systemError' ? 'failed' : 'completed';
        this.settleTurn(thread, turn, source);
    }

    private settleTurn(
        thread: CodexThreadRuntime,
        turn: CodexTurnRuntime,
        source: CodexTurnCompletion['source'],
    ): void {
        if (turn.settled) return;
        turn.settled = true;
        if (thread.activeTurnId === turn.turnId) thread.activeTurnId = null;
        const controller = this.turnCompletions.get(turnKey(thread.threadId, turn.turnId));
        if (controller) {
            controller.resolve({
                threadId: thread.threadId,
                turnId: turn.turnId,
                status: turn.status,
                aborted: turn.status === 'interrupted',
                source,
            });
            this.turnCompletions.delete(turnKey(thread.threadId, turn.turnId));
        }
    }
}

function createCompletionController(): CompletionController {
    let resolvePromise!: (completion: CodexTurnCompletion) => void;
    let rejectPromise!: (error: Error) => void;
    const controller: CompletionController = {
        promise: new Promise<CodexTurnCompletion>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        }),
        resolve: (completion) => {
            if (controller.settled) return;
            controller.settled = true;
            resolvePromise(completion);
        },
        reject: (error) => {
            if (controller.settled) return;
            controller.settled = true;
            rejectPromise(error);
        },
        settled: false,
    };
    return controller;
}

function turnKey(threadId: string, turnId: string): string {
    return `${threadId}\0${turnId}`;
}

function isTerminalTurnStatus(status: TurnStatus): boolean {
    return status === 'completed' || status === 'interrupted' || status === 'failed';
}

function isTurnNewer(candidate: CodexTurnRuntime, current: CodexTurnRuntime): boolean {
    const candidateStartedAt = candidate.snapshot?.startedAt;
    const currentStartedAt = current.snapshot?.startedAt;
    return typeof candidateStartedAt === 'number'
        && typeof currentStartedAt === 'number'
        && candidateStartedAt > currentStartedAt;
}
