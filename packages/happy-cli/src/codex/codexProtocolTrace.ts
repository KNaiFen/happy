/** Payload-free JSON-RPC trace recording and deterministic timing replay. */

import { createHmac, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
    SYNC_V4_DIAGNOSTIC_FILE_BYTES,
    SYNC_V4_DIAGNOSTIC_FILE_SEGMENTS,
    syncV4DiagnosticHash,
} from '@/api/syncV4Diagnostics';
import {
    BoundedJsonlWriter,
    type BoundedJsonlWriterStats,
} from '@/utils/boundedJsonlWriter';
import {
    isRedactedCodexProtocolMethod,
    redactCodexProtocolMethod,
} from './codexProtocolMethod';

const TRACE_VERSION = 1;
const MAX_TRACE_DEPTH = 10;
const MAX_TRACE_NODES = 1_024;
const MAX_TRACE_IDS = 128;
const DEFAULT_MAX_MEMORY_ENTRIES = 4_096;
const DEFAULT_MAX_PENDING_REQUESTS = 4_096;
const MAX_TRACE_RECORD_BYTES = 64 * 1024;
const MAX_TRACE_METHOD_BYTES = 128;

export type CodexProtocolTraceDirection = 'outbound' | 'inbound';
export type CodexProtocolTraceKind = 'request' | 'response' | 'notification' | 'unknown';

export type CodexProtocolTraceShape =
    | { type: 'null' | 'boolean' | 'number' | 'string' }
    | { type: 'array'; length: number; members: CodexProtocolTraceShapeMember[] }
    | { type: 'object'; fieldCount: number; members: CodexProtocolTraceShapeMember[] }
    | { type: 'truncated' };

export interface CodexProtocolTraceShapeMember {
    count: number;
    shape: CodexProtocolTraceShape;
}

export interface CodexProtocolTraceId {
    kind: 'thread' | 'turn' | 'item' | 'request' | 'clientMessage' | 'session' | 'entity' | 'mutation' | 'other';
    hash: string;
}

export interface CodexProtocolTraceEntry {
    version: 1;
    sequence: number;
    offsetMs: number;
    direction: CodexProtocolTraceDirection;
    kind: CodexProtocolTraceKind;
    method: string | null;
    rpcIdHash: string | null;
    ids: CodexProtocolTraceId[];
    shape: CodexProtocolTraceShape;
}

export interface CodexProtocolTraceSink {
    record(direction: CodexProtocolTraceDirection, message: unknown): void;
}

export interface CodexProtocolTraceStats extends BoundedJsonlWriterStats {
    memoryEntries: number;
    pendingRequests: number;
    invalidRecords: number;
}

interface RecorderOptions {
    now?: () => number;
    hashSecret?: Uint8Array;
    maxMemoryEntries?: number;
    maxPendingRequests?: number;
    maxFileBytes?: number;
    maxFileSegments?: number;
}

interface ReplayOptions {
    /** 0 replays immediately; 1 preserves timing; values above 1 accelerate it. */
    speed?: number;
    signal?: AbortSignal;
}

const traceShapeSchema: z.ZodType<CodexProtocolTraceShape> = z.lazy(() => z.union([
    z.object({ type: z.enum(['null', 'boolean', 'number', 'string']) }).strict(),
    z.object({
        type: z.literal('array'),
        length: z.number().int().nonnegative(),
        members: z.array(traceShapeMemberSchema),
    }).strict(),
    z.object({
        type: z.literal('object'),
        fieldCount: z.number().int().nonnegative(),
        members: z.array(traceShapeMemberSchema),
    }).strict(),
    z.object({ type: z.literal('truncated') }).strict(),
]));

const traceShapeMemberSchema: z.ZodType<CodexProtocolTraceShapeMember> = z.lazy(() => z.object({
    count: z.number().int().positive(),
    shape: traceShapeSchema,
}).strict());

const traceEntrySchema: z.ZodType<CodexProtocolTraceEntry> = z.object({
    version: z.literal(TRACE_VERSION),
    sequence: z.number().int().nonnegative(),
    offsetMs: z.number().int().nonnegative(),
    direction: z.enum(['outbound', 'inbound']),
    kind: z.enum(['request', 'response', 'notification', 'unknown']),
    method: z.string()
        .min(1)
        .max(MAX_TRACE_METHOD_BYTES)
        .refine(isRedactedCodexProtocolMethod)
        .nullable(),
    rpcIdHash: z.string().regex(/^[0-9a-f]{24}$/).nullable(),
    ids: z.array(z.object({
        kind: z.enum(['thread', 'turn', 'item', 'request', 'clientMessage', 'session', 'entity', 'mutation', 'other']),
        hash: z.string().regex(/^(?:[0-9a-f]{16}|[0-9a-f]{24})$/),
    }).strict()).max(MAX_TRACE_IDS),
    shape: traceShapeSchema,
}).strict();

/**
 * Recorder instances never retain raw messages. File writes are serialized so
 * callers can safely emit trace events from concurrent notification handlers.
 */
export class CodexProtocolTraceRecorder implements CodexProtocolTraceSink {
    static async open(path: string, options: RecorderOptions = {}): Promise<CodexProtocolTraceRecorder> {
        const writer = await BoundedJsonlWriter.open(path, {
            maxFileBytes: options.maxFileBytes ?? SYNC_V4_DIAGNOSTIC_FILE_BYTES,
            maxSegments: options.maxFileSegments ?? SYNC_V4_DIAGNOSTIC_FILE_SEGMENTS,
            maxRecordBytes: MAX_TRACE_RECORD_BYTES,
        });
        return new CodexProtocolTraceRecorder(options, writer);
    }

    private readonly now: () => number;
    private readonly hashSecret: Uint8Array;
    private readonly maxMemoryEntries: number;
    private readonly maxPendingRequests: number;
    private readonly startedAt: number;
    private readonly requestMethods = new Map<string, { method: string; rpcIdHash: string }>();
    private readonly entries: CodexProtocolTraceEntry[] = [];
    private nextEntryIndex = 0;
    private sequence = 0;
    private invalidRecords = 0;
    private closed = false;

    constructor(
        options: RecorderOptions = {},
        private readonly writer: BoundedJsonlWriter | null = null,
    ) {
        this.now = options.now ?? Date.now;
        this.hashSecret = options.hashSecret ?? randomBytes(32);
        this.maxMemoryEntries = boundedCount(options.maxMemoryEntries, DEFAULT_MAX_MEMORY_ENTRIES);
        this.maxPendingRequests = boundedCount(options.maxPendingRequests, DEFAULT_MAX_PENDING_REQUESTS);
        this.startedAt = this.now();
    }

    record(direction: CodexProtocolTraceDirection, message: unknown): void {
        if (this.closed) return;
        let entry: CodexProtocolTraceEntry;
        try {
            entry = this.createEntry(direction, message);
        } catch {
            this.invalidRecords += 1;
            return;
        }
        if (this.maxMemoryEntries > 0) {
            if (this.entries.length < this.maxMemoryEntries) {
                this.entries.push(entry);
            } else {
                this.entries[this.nextEntryIndex] = entry;
                this.nextEntryIndex = (this.nextEntryIndex + 1) % this.maxMemoryEntries;
            }
        }
        this.writer?.appendJson(entry);
    }

    stats(): CodexProtocolTraceStats {
        return {
            ...(this.writer?.stats() ?? {
                currentFileBytes: 0,
                pendingBytes: 0,
                droppedRecords: 0,
                writeFailures: 0,
            }),
            memoryEntries: this.entries.length,
            pendingRequests: this.requestMethods.size,
            invalidRecords: this.invalidRecords,
        };
    }

    snapshot(): CodexProtocolTraceEntry[] {
        const ordered = this.entries.length < this.maxMemoryEntries || this.nextEntryIndex === 0
            ? this.entries
            : [
                ...this.entries.slice(this.nextEntryIndex),
                ...this.entries.slice(0, this.nextEntryIndex),
            ];
        return ordered.map((entry) => structuredClone(entry));
    }

    async flush(): Promise<void> {
        await this.writer?.flush();
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.writer?.close();
    }

    private createEntry(direction: CodexProtocolTraceDirection, message: unknown): CodexProtocolTraceEntry {
        const value = record(message);
        const rawMethod = typeof value.method === 'string' && value.method.length > 0 ? value.method : null;
        const method = rawMethod === null
            ? null
            : redactCodexProtocolMethod(rawMethod);
        const rpcId = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id) : null;
        const hasResponse = Object.prototype.hasOwnProperty.call(value, 'result')
            || Object.prototype.hasOwnProperty.call(value, 'error');
        const kind: CodexProtocolTraceKind = method
            ? rpcId === null ? 'notification' : 'request'
            : rpcId !== null && hasResponse ? 'response' : 'unknown';
        let responseMethod: string | null = method;
        let rpcIdHash: string | null = null;
        if (rpcId !== null && kind === 'request') {
            rpcIdHash = this.hash(`rpc:${direction}`, rpcId);
            this.requestMethods.set(`${direction}:${rpcIdHash}`, { method: method!, rpcIdHash });
            while (this.requestMethods.size > this.maxPendingRequests) {
                const oldest = this.requestMethods.keys().next().value;
                if (typeof oldest !== 'string') break;
                this.requestMethods.delete(oldest);
            }
        } else if (rpcId !== null && kind === 'response') {
            const origin = direction === 'outbound' ? 'inbound' : 'outbound';
            const responseRpcIdHash = this.hash(`rpc:${origin}`, rpcId);
            const correlationKey = `${origin}:${responseRpcIdHash}`;
            const pending = this.requestMethods.get(correlationKey);
            responseMethod = pending?.method ?? null;
            rpcIdHash = pending?.rpcIdHash ?? responseRpcIdHash;
            this.requestMethods.delete(correlationKey);
        }

        const payload = protocolPayload(value);
        return {
            version: TRACE_VERSION,
            sequence: this.sequence++,
            offsetMs: Math.max(0, Math.trunc(this.now() - this.startedAt)),
            direction,
            kind,
            method: responseMethod,
            rpcIdHash,
            ids: collectIds(payload, (_kindName, id) => syncV4DiagnosticHash(id)),
            shape: traceShape(payload),
        };
    }

    private hash(namespace: string, value: string): string {
        return createHmac('sha256', this.hashSecret)
            .update(namespace)
            .update('\0')
            .update(value)
            .digest('hex')
            .slice(0, 24);
    }
}

export class CodexProtocolTraceReplayer {
    static async fromFile(path: string): Promise<CodexProtocolTraceReplayer> {
        return new CodexProtocolTraceReplayer(await readCodexProtocolTrace(path));
    }

    private readonly entries: CodexProtocolTraceEntry[];

    constructor(entries: readonly CodexProtocolTraceEntry[]) {
        this.entries = [...entries].sort((left, right) => left.sequence - right.sequence);
    }

    async replay(
        onEntry: (entry: CodexProtocolTraceEntry) => void | Promise<void>,
        options: ReplayOptions = {},
    ): Promise<void> {
        const speed = options.speed ?? 0;
        if (!Number.isFinite(speed) || speed < 0) throw new Error('Trace replay speed must be a finite nonnegative number');
        let previousOffset = 0;
        for (const entry of this.entries) {
            if (options.signal?.aborted) throw abortError();
            const delayMs = speed === 0 ? 0 : Math.max(0, (entry.offsetMs - previousOffset) / speed);
            if (delayMs > 0) await delay(delayMs, options.signal);
            await onEntry(structuredClone(entry));
            previousOffset = entry.offsetMs;
        }
    }
}

export async function readCodexProtocolTrace(path: string): Promise<CodexProtocolTraceEntry[]> {
    const entries: CodexProtocolTraceEntry[] = [];
    for (const tracePath of await traceSegmentPaths(path)) {
        const content = await readFile(tracePath, 'utf8');
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (!line.trim()) continue;
            try {
                entries.push(traceEntrySchema.parse(JSON.parse(line)));
            } catch (error) {
                const isTruncatedTail = index === lines.length - 1 && !content.endsWith('\n');
                if (isTruncatedTail) break;
                throw new Error(`Invalid Codex protocol trace at ${basename(tracePath)}:${index + 1}`, { cause: error });
            }
        }
    }
    return entries.sort((left, right) => left.sequence - right.sequence);
}

async function traceSegmentPaths(path: string): Promise<string[]> {
    const directory = dirname(path);
    const filename = basename(path);
    const entries = await readdir(directory).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return [];
        throw error;
    });
    return entries
        .flatMap((entry) => {
            if (entry === filename) return [{ path: join(directory, entry), segment: 0 }];
            const match = new RegExp(`^${escapeRegExp(filename)}\\.(\\d+)$`).exec(entry);
            return match ? [{ path: join(directory, entry), segment: Number(match[1]) }] : [];
        })
        .sort((left, right) => right.segment - left.segment)
        .map((entry) => entry.path);
}

function traceShape(value: unknown): CodexProtocolTraceShape {
    return buildTraceShape(value, 0, { remaining: MAX_TRACE_NODES });
}

function buildTraceShape(
    value: unknown,
    depth: number,
    budget: { remaining: number },
): CodexProtocolTraceShape {
    budget.remaining -= 1;
    if (budget.remaining < 0 || depth >= MAX_TRACE_DEPTH) return { type: 'truncated' };
    if (value === null || value === undefined) return { type: 'null' };
    if (typeof value === 'string') return { type: 'string' };
    if (typeof value === 'number') return { type: 'number' };
    if (typeof value === 'boolean') return { type: 'boolean' };
    if (Array.isArray(value)) {
        const shapes: CodexProtocolTraceShape[] = [];
        let index = 0;
        while (index < value.length && budget.remaining > 0) {
            shapes.push(buildTraceShape(value[index], depth + 1, budget));
            index += 1;
        }
        return {
            type: 'array',
            length: value.length,
            members: groupShapes(shapes, value.length - index),
        };
    }
    if (typeof value === 'object') {
        const shapes: CodexProtocolTraceShape[] = [];
        let fieldCount = 0;
        let truncatedCount = 0;
        for (const key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            if (budget.remaining <= 0 || fieldCount >= MAX_TRACE_NODES) {
                fieldCount += 1;
                truncatedCount = 1;
                break;
            }
            const entry = (value as Record<string, unknown>)[key];
            if (entry === undefined) continue;
            fieldCount += 1;
            shapes.push(buildTraceShape(entry, depth + 1, budget));
        }
        return {
            type: 'object',
            fieldCount,
            members: groupShapes(shapes, truncatedCount),
        };
    }
    return { type: 'truncated' };
}

function groupShapes(
    shapes: CodexProtocolTraceShape[],
    truncatedCount = 0,
): CodexProtocolTraceShapeMember[] {
    const groups = new Map<string, CodexProtocolTraceShapeMember>();
    for (const shape of shapes) {
        const key = JSON.stringify(shape);
        const existing = groups.get(key);
        if (existing) existing.count += 1;
        else groups.set(key, { count: 1, shape });
    }
    if (truncatedCount > 0) {
        const shape = { type: 'truncated' as const };
        const key = JSON.stringify(shape);
        const existing = groups.get(key);
        if (existing) existing.count += truncatedCount;
        else groups.set(key, { count: truncatedCount, shape });
    }
    return [...groups.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, member]) => member);
}

function collectIds(
    value: unknown,
    hash: (kind: CodexProtocolTraceId['kind'], id: string) => string,
): CodexProtocolTraceId[] {
    const ids = new Map<string, CodexProtocolTraceId>();
    const budget = { remaining: MAX_TRACE_NODES };
    const visit = (
        current: unknown,
        key: string | null,
        parent: Record<string, unknown> | null,
        depth: number,
    ): void => {
        budget.remaining -= 1;
        if (budget.remaining < 0 || depth >= MAX_TRACE_DEPTH || ids.size >= MAX_TRACE_IDS) return;
        const kind = key ? idKind(key, parent) : null;
        if (kind && (typeof current === 'string' || typeof current === 'number')) {
            const digest = hash(kind, String(current));
            ids.set(`${kind}:${digest}`, { kind, hash: digest });
            return;
        }
        if (kind && Array.isArray(current)) {
            for (const entry of current) {
                if (typeof entry !== 'string' && typeof entry !== 'number') continue;
                const digest = hash(kind, String(entry));
                ids.set(`${kind}:${digest}`, { kind, hash: digest });
                if (ids.size >= MAX_TRACE_IDS) return;
            }
            return;
        }
        if (Array.isArray(current)) {
            for (const entry of current) {
                if (budget.remaining <= 0 || ids.size >= MAX_TRACE_IDS) break;
                visit(entry, null, null, depth + 1);
            }
            return;
        }
        if (current && typeof current === 'object') {
            const currentRecord = current as Record<string, unknown>;
            for (const childKey in currentRecord) {
                if (budget.remaining <= 0 || ids.size >= MAX_TRACE_IDS) break;
                if (!Object.prototype.hasOwnProperty.call(currentRecord, childKey)) continue;
                visit(currentRecord[childKey], childKey, currentRecord, depth + 1);
            }
        }
    };
    visit(value, null, null, 0);
    return [...ids.values()].sort((left, right) => (
        left.kind.localeCompare(right.kind) || left.hash.localeCompare(right.hash)
    ));
}

function idKind(key: string, parent: Record<string, unknown> | null): CodexProtocolTraceId['kind'] | null {
    if (key.length > 128) return null;
    const normalized = key.replace(/[_-]/g, '').toLowerCase();
    if (!normalized.endsWith('id') && !normalized.endsWith('ids')) return null;
    if (normalized === 'id' && parent) {
        if (Array.isArray(parent.turns)) return 'thread';
        if (Array.isArray(parent.items)) return 'turn';
        if (typeof parent.type === 'string') return 'item';
    }
    if (normalized.includes('thread')) return 'thread';
    if (normalized.includes('turn')) return 'turn';
    if (normalized.includes('item') || normalized.includes('call')) return 'item';
    if (normalized.includes('client') && normalized.includes('message')) return 'clientMessage';
    if (normalized.includes('request') || normalized.includes('approval') || normalized.includes('elicitation')) return 'request';
    if (normalized.includes('session')) return 'session';
    if (normalized.includes('entity')) return 'entity';
    if (normalized.includes('mutation')) return 'mutation';
    return 'other';
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function protocolPayload(value: Record<string, unknown>): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const key of ['params', 'result', 'error'] as const) {
        if (value[key] !== undefined) payload[key] = value[key];
    }
    return payload;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function abortError(): Error {
    const error = new Error('Codex protocol trace replay aborted');
    error.name = 'AbortError';
    return error;
}

function boundedCount(value: number | undefined, fallback: number): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 0) {
        throw new Error('Codex protocol trace bounds must be nonnegative integers');
    }
    return resolved;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorCode(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
}
