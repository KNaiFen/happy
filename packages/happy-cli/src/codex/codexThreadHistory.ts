import { resolve } from 'node:path';

import {
    CodexAppServerClient,
    isCodexThreadUnavailableRpcResponse,
} from './codexAppServerClient';
import type { Thread } from './protocol';
import { AsyncLock } from '@/utils/lock';

const THREAD_PAGE_SIZE = 50;
const THREAD_TITLE_LIMIT = 4_096;
const THREAD_PREVIEW_LIMIT = 16_384;
const THREAD_DIRECTORY_LIMIT = 8_192;
const THREAD_CURSOR_LIMIT = 4_096;
const THREAD_SEARCH_LIMIT = 512;
const THREAD_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'unknown'] as const;

export type CodexThreadHistoryStatus = 'notLoaded' | 'idle' | 'active' | 'systemError';
export type CodexThreadHistorySource = typeof THREAD_SOURCE_KINDS[number];

export interface CodexThreadHistorySummary {
    threadId: string;
    title: string;
    preview: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
    recencyAt: number;
    source: CodexThreadHistorySource;
    status: CodexThreadHistoryStatus;
}

export interface CodexListThreadsRequest {
    directory: string;
    cursor?: string | null;
    searchTerm?: string | null;
}

export interface CodexListThreadsResult {
    type: 'success';
    threads: CodexThreadHistorySummary[];
    nextCursor: string | null;
}

export interface CodexThreadHistoryClient {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    listThreads(opts: Parameters<CodexAppServerClient['listThreads']>[0]): ReturnType<CodexAppServerClient['listThreads']>;
    readThread(opts: Parameters<CodexAppServerClient['readThread']>[0]): ReturnType<CodexAppServerClient['readThread']>;
}

export class CodexThreadUnavailableError extends Error {
    constructor() {
        super('The selected Codex thread is no longer available');
        this.name = 'CodexThreadUnavailableError';
    }
}

export class CodexThreadBindingError extends Error {
    constructor() {
        super('The selected Codex thread does not match the requested Happy binding');
        this.name = 'CodexThreadBindingError';
    }
}

function normalizeDirectory(directory: string): string {
    if (
        typeof directory !== 'string'
        || directory.trim().length === 0
        || directory.length > THREAD_DIRECTORY_LIMIT
    ) {
        throw new Error('directory is required');
    }
    return resolve(directory.trim());
}

function normalizeSource(source: Thread['source']): CodexThreadHistorySource {
    return typeof source === 'string' && THREAD_SOURCE_KINDS.includes(source as CodexThreadHistorySource)
        ? source as CodexThreadHistorySource
        : 'unknown';
}

function isRootHistoryThread(thread: Thread): boolean {
    return !thread.ephemeral
        && thread.parentThreadId === null
        && !(typeof thread.source === 'object' && thread.source !== null && 'subAgent' in thread.source);
}

function summarizeThread(thread: Thread): CodexThreadHistorySummary {
    const preview = thread.preview.trim().slice(0, THREAD_PREVIEW_LIMIT);
    const title = (thread.name?.trim() || preview).slice(0, THREAD_TITLE_LIMIT);
    return {
        threadId: thread.id,
        title,
        preview,
        cwd: resolve(thread.cwd),
        createdAt: thread.createdAt * 1_000,
        updatedAt: thread.updatedAt * 1_000,
        recencyAt: (thread.recencyAt ?? thread.updatedAt) * 1_000,
        source: normalizeSource(thread.source),
        status: thread.status.type,
    };
}

export class CodexThreadHistoryService {
    private readonly lock = new AsyncLock();
    private client: CodexThreadHistoryClient | null = null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private idleGeneration = 0;

    constructor(private readonly options: {
        createClient?: () => CodexThreadHistoryClient;
        idleTimeoutMs?: number;
    } = {}) {}

    async list(request: CodexListThreadsRequest): Promise<CodexListThreadsResult> {
        const directory = normalizeDirectory(request.directory);
        const searchTerm = request.searchTerm?.trim() || null;
        if ((request.cursor?.length ?? 0) > THREAD_CURSOR_LIMIT) {
            throw new Error('thread list cursor is too long');
        }
        if ((searchTerm?.length ?? 0) > THREAD_SEARCH_LIMIT) {
            throw new Error('thread search term is too long');
        }
        return this.withClient(async (client) => {
            const response = await client.listThreads({
                cursor: request.cursor ?? null,
                limit: THREAD_PAGE_SIZE,
                sortKey: 'recency_at',
                sortDirection: 'desc',
                sourceKinds: [...THREAD_SOURCE_KINDS],
                archived: false,
                cwd: directory,
                searchTerm,
            });
            if ((response.nextCursor?.length ?? 0) > THREAD_CURSOR_LIMIT) {
                throw new Error('Codex app-server returned an oversized thread cursor');
            }
            return {
                type: 'success',
                threads: response.data
                    .filter((thread) => isRootHistoryThread(thread) && resolve(thread.cwd) === directory)
                    .map(summarizeThread),
                nextCursor: response.nextCursor,
            };
        });
    }

    async inspect(directoryInput: string, threadId: string): Promise<CodexThreadHistorySummary> {
        const directory = normalizeDirectory(directoryInput);
        if (typeof threadId !== 'string' || threadId.trim().length === 0 || threadId.length > 256) {
            throw new Error('threadId is required');
        }
        return this.withClient(async (client) => {
            let response: Awaited<ReturnType<CodexThreadHistoryClient['readThread']>>;
            try {
                response = await client.readThread({
                    threadId: threadId.trim(),
                    includeTurns: false,
                    emitSnapshot: false,
                });
            } catch (error) {
                if (isCodexThreadUnavailableRpcResponse(error, threadId.trim())) {
                    throw new CodexThreadUnavailableError();
                }
                throw error;
            }
            const { thread } = response;
            if (!isRootHistoryThread(thread)) {
                throw new CodexThreadBindingError();
            }
            if (resolve(thread.cwd) !== directory) {
                throw new CodexThreadBindingError();
            }
            return summarizeThread(thread);
        });
    }

    async close(): Promise<void> {
        await this.lock.inLock(async () => {
            this.clearIdleTimer();
            const client = this.client;
            this.client = null;
            await client?.disconnect().catch(() => undefined);
        });
    }

    private async withClient<T>(handler: (client: CodexThreadHistoryClient) => Promise<T>): Promise<T> {
        return this.lock.inLock(async () => {
            this.clearIdleTimer();
            let client = this.client;
            if (!client) {
                client = this.options.createClient?.() ?? new CodexAppServerClient();
                try {
                    await client.connect();
                    this.client = client;
                } catch (error) {
                    await client.disconnect().catch(() => undefined);
                    throw error;
                }
            }
            try {
                return await handler(client);
            } finally {
                this.scheduleIdleClose();
            }
        });
    }

    private clearIdleTimer(): void {
        this.idleGeneration += 1;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    private scheduleIdleClose(): void {
        const generation = ++this.idleGeneration;
        const timeoutMs = this.options.idleTimeoutMs ?? 30_000;
        this.idleTimer = setTimeout(() => {
            void this.lock.inLock(async () => {
                if (generation !== this.idleGeneration) return;
                this.idleTimer = null;
                const client = this.client;
                this.client = null;
                await client?.disconnect().catch(() => undefined);
            }).catch(() => undefined);
        }, timeoutMs);
        this.idleTimer.unref?.();
    }
}
