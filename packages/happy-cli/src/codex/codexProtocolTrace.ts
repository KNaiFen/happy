/** Payload-free JSON-RPC trace recording and deterministic timing replay. */

import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const TRACE_VERSION = 1;
const MAX_TRACE_DEPTH = 10;
const MAX_TRACE_NODES = 1_024;
const MAX_TRACE_IDS = 128;

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

interface RecorderOptions {
    now?: () => number;
    hashSecret?: Uint8Array;
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
    method: z.string().min(1).max(512).nullable(),
    rpcIdHash: z.string().regex(/^[0-9a-f]{24}$/).nullable(),
    ids: z.array(z.object({
        kind: z.enum(['thread', 'turn', 'item', 'request', 'clientMessage', 'session', 'entity', 'mutation', 'other']),
        hash: z.string().regex(/^[0-9a-f]{24}$/),
    }).strict()).max(MAX_TRACE_IDS),
    shape: traceShapeSchema,
}).strict();

/**
 * Recorder instances never retain raw messages. File writes are serialized so
 * callers can safely emit trace events from concurrent notification handlers.
 */
export class CodexProtocolTraceRecorder implements CodexProtocolTraceSink {
    static async open(path: string, options: RecorderOptions = {}): Promise<CodexProtocolTraceRecorder> {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const handle = await open(path, 'a', 0o600);
        await handle.chmod(0o600);
        return new CodexProtocolTraceRecorder(options, handle);
    }

    private readonly now: () => number;
    private readonly hashSecret: Uint8Array;
    private readonly startedAt: number;
    private readonly requestMethods = new Map<string, { method: string; rpcIdHash: string }>();
    private readonly entries: CodexProtocolTraceEntry[] = [];
    private pipeline: Promise<void> = Promise.resolve();
    private failure: unknown = null;
    private sequence = 0;
    private closed = false;

    constructor(
        options: RecorderOptions = {},
        private readonly handle: FileHandle | null = null,
    ) {
        this.now = options.now ?? Date.now;
        this.hashSecret = options.hashSecret ?? randomBytes(32);
        this.startedAt = this.now();
    }

    record(direction: CodexProtocolTraceDirection, message: unknown): void {
        if (this.closed) return;
        const entry = this.createEntry(direction, message);
        this.entries.push(entry);
        if (!this.handle) return;
        const line = `${JSON.stringify(entry)}\n`;
        this.pipeline = this.pipeline.then(async () => {
            await this.handle!.writeFile(line, { encoding: 'utf8' });
        }).catch((error) => {
            this.failure ??= error;
        });
    }

    snapshot(): CodexProtocolTraceEntry[] {
        return this.entries.map((entry) => structuredClone(entry));
    }

    async flush(): Promise<void> {
        await this.pipeline;
        if (this.failure) throw this.failure;
        await this.handle?.sync();
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.flush();
        } finally {
            await this.handle?.close();
        }
    }

    private createEntry(direction: CodexProtocolTraceDirection, message: unknown): CodexProtocolTraceEntry {
        const value = record(message);
        const method = typeof value.method === 'string' && value.method.length > 0 ? value.method : null;
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
            this.requestMethods.set(`${direction}:${rpcId}`, { method: method!, rpcIdHash });
        } else if (rpcId !== null && kind === 'response') {
            const origin = direction === 'outbound' ? 'inbound' : 'outbound';
            const pending = this.requestMethods.get(`${origin}:${rpcId}`);
            responseMethod = pending?.method ?? null;
            rpcIdHash = pending?.rpcIdHash ?? this.hash(`rpc:${origin}`, rpcId);
            this.requestMethods.delete(`${origin}:${rpcId}`);
        }

        const payload = Object.fromEntries(
            Object.entries(value).filter(([key, entry]) => key !== 'jsonrpc'
                && key !== 'id'
                && key !== 'method'
                && entry !== undefined),
        );
        return {
            version: TRACE_VERSION,
            sequence: this.sequence++,
            offsetMs: Math.max(0, Math.trunc(this.now() - this.startedAt)),
            direction,
            kind,
            method: responseMethod,
            rpcIdHash,
            ids: collectIds(payload, (kindName, id) => this.hash(`id:${kindName}`, id)),
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
    const content = await readFile(path, 'utf8');
    const lines = content.split('\n');
    const entries: CodexProtocolTraceEntry[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) continue;
        try {
            entries.push(traceEntrySchema.parse(JSON.parse(line)));
        } catch (error) {
            const isTruncatedTail = index === lines.length - 1 && !content.endsWith('\n');
            if (isTruncatedTail) break;
            throw new Error(`Invalid Codex protocol trace at line ${index + 1}`, { cause: error });
        }
    }
    return entries.sort((left, right) => left.sequence - right.sequence);
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
        return {
            type: 'array',
            length: value.length,
            members: groupShapes(value.map((entry) => buildTraceShape(entry, depth + 1, budget))),
        };
    }
    if (typeof value === 'object') {
        const values = Object.values(value).filter((entry) => entry !== undefined);
        return {
            type: 'object',
            fieldCount: values.length,
            members: groupShapes(values.map((entry) => buildTraceShape(entry, depth + 1, budget))),
        };
    }
    return { type: 'truncated' };
}

function groupShapes(shapes: CodexProtocolTraceShape[]): CodexProtocolTraceShapeMember[] {
    const groups = new Map<string, CodexProtocolTraceShapeMember>();
    for (const shape of shapes) {
        const key = JSON.stringify(shape);
        const existing = groups.get(key);
        if (existing) existing.count += 1;
        else groups.set(key, { count: 1, shape });
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
    const visit = (current: unknown, key: string | null, parent: Record<string, unknown> | null): void => {
        if (ids.size >= MAX_TRACE_IDS) return;
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
            for (const entry of current) visit(entry, null, null);
            return;
        }
        if (current && typeof current === 'object') {
            const currentRecord = current as Record<string, unknown>;
            for (const [childKey, child] of Object.entries(currentRecord)) visit(child, childKey, currentRecord);
        }
    };
    visit(value, null, null);
    return [...ids.values()].sort((left, right) => (
        left.kind.localeCompare(right.kind) || left.hash.localeCompare(right.hash)
    ));
}

function idKind(key: string, parent: Record<string, unknown> | null): CodexProtocolTraceId['kind'] | null {
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
