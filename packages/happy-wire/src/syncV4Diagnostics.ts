import * as z from 'zod';
import { CodexEntityTypeSchema } from './syncV4';

export const SYNC_V4_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const MAX_SYNC_V4_DIAGNOSTIC_RECORD_BYTES = 2 * 1024;

export const SyncV4DiagnosticLevelSchema = z.enum([
  'debug',
  'info',
  'warn',
  'error',
]);
export type SyncV4DiagnosticLevel = z.infer<typeof SyncV4DiagnosticLevelSchema>;

export const SyncV4DiagnosticComponentSchema = z.enum([
  'cli.sync',
  'cli.gateway',
  'cli.protocol',
  'app.sync',
  'app.registry',
  'app.projection',
  'server.sync',
]);
export type SyncV4DiagnosticComponent = z.infer<typeof SyncV4DiagnosticComponentSchema>;

export const SyncV4DiagnosticEventSchema = z.enum([
  'lifecycle',
  'transport',
  'outbox',
  'ack',
  'changes',
  'cursor',
  'snapshot',
  'journal',
  'connection',
  'rpc',
  'notification',
  'thread',
  'turn',
  'request',
  'relation',
  'migration',
  'stream',
  'retry',
  'projection',
  'invalidation',
  'prune',
  'protocolTrace',
]);
export type SyncV4DiagnosticEvent = z.infer<typeof SyncV4DiagnosticEventSchema>;

export const SyncV4DiagnosticPhaseSchema = z.enum([
  'started',
  'completed',
  'failed',
  'scheduled',
  'enqueued',
  'acknowledged',
  'received',
  'applied',
  'advanced',
  'required',
  'replayed',
  'compacted',
  'changed',
  'dropped',
  'poisoned',
  'restored',
  'invalidated',
  'served',
  'exited',
  'unknown',
]);
export type SyncV4DiagnosticPhase = z.infer<typeof SyncV4DiagnosticPhaseSchema>;

export const SyncV4DiagnosticStateSchema = z.enum([
  'starting',
  'ready',
  'stopping',
  'stopped',
  'retrying',
  'unknown',
  'connecting',
  'connected',
  'disconnected',
  'reconnecting',
  'healthy',
  'degraded',
  'poisoned',
  'pending',
  'received',
  'executing',
  'responseReady',
  'responseSupplied',
  'resolved',
  'succeeded',
  'failed',
  'resultUnknown',
  'outcomeUnknown',
  'notReplayed',
  'accepted',
  'duplicate',
  'superseded',
  'notLoaded',
  'idle',
  'active',
  'systemError',
  'inProgress',
  'completed',
  'interrupted',
  'blocked',
  'declined',
  'cancelled',
  'error',
  'importing',
  'activating',
  'replaying',
  'compacting',
]);
export type SyncV4DiagnosticState = z.infer<typeof SyncV4DiagnosticStateSchema>;

export const SyncV4DiagnosticSourceSchema = z.enum([
  'cache',
  'change',
  'snapshot',
  'poll',
  'socket',
  'command',
  'notification',
  'recovery',
  'migration',
]);
export type SyncV4DiagnosticSource = z.infer<typeof SyncV4DiagnosticSourceSchema>;

export const SyncV4DiagnosticReasonSchema = z.enum([
  'journalExpired',
  'journalGap',
  'cacheCorrupt',
  'snapshotInterrupted',
  'socketInvalidation',
  'poll',
  'foreground',
  'reconnect',
  'processExit',
  'timeout',
  'conflict',
  'validation',
  'storage',
  'unknownMethod',
  'unknownVariant',
  'shutdown',
  'startup',
  'manual',
]);
export type SyncV4DiagnosticReason = z.infer<typeof SyncV4DiagnosticReasonSchema>;

export const SyncV4DiagnosticErrorKindSchema = z.enum([
  'network',
  'timeout',
  'validation',
  'conflict',
  'storage',
  'crypto',
  'projection',
  'provider',
  'protocol',
  'authentication',
  'authorization',
  'notFound',
  'cancelled',
  'rateLimited',
  'server',
  'unknown',
]);
export type SyncV4DiagnosticErrorKind = z.infer<typeof SyncV4DiagnosticErrorKindSchema>;

export const SyncV4DiagnosticTransportOperationSchema = z.enum([
  'capabilities',
  'mutations',
  'changes',
  'snapshot',
  'invalidation',
]);
export type SyncV4DiagnosticTransportOperation = z.infer<typeof SyncV4DiagnosticTransportOperationSchema>;

export const SyncV4DiagnosticRpcFamilySchema = z.enum([
  'initialize',
  'thread',
  'turn',
  'item',
  'review',
  'compact',
  'request',
  'mcp',
  'skills',
  'model',
  'goal',
  'collaboration',
  'unknown',
]);
export type SyncV4DiagnosticRpcFamily = z.infer<typeof SyncV4DiagnosticRpcFamilySchema>;

export const SyncV4DiagnosticClientTypeSchema = z.enum([
  'cli-coding-session',
  'cli-control-plane',
  'ios',
  'android',
  'web',
  'desktop',
  'macos',
  'windows',
  'unknown',
]);
export type SyncV4DiagnosticClientType = z.infer<typeof SyncV4DiagnosticClientTypeSchema>;

export const SyncV4DiagnosticTransportSecuritySchema = z.enum([
  'https',
  'insecureHttp',
]);
export type SyncV4DiagnosticTransportSecurity = z.infer<
  typeof SyncV4DiagnosticTransportSecuritySchema
>;

const diagnosticIdSchema = z.string().regex(/^[A-Za-z0-9_-]{12,64}$/);
export const SyncV4TraceIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
const stableVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const nonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const SyncV4DiagnosticRecordSchema = z.object({
  schemaVersion: z.literal(SYNC_V4_DIAGNOSTIC_SCHEMA_VERSION),
  timestamp: nonnegativeIntegerSchema,
  level: SyncV4DiagnosticLevelSchema,
  component: SyncV4DiagnosticComponentSchema,
  event: SyncV4DiagnosticEventSchema,
  phase: SyncV4DiagnosticPhaseSchema,
  traceId: SyncV4TraceIdSchema.optional(),
  sessionHash: diagnosticIdSchema.optional(),
  producerHash: diagnosticIdSchema.optional(),
  threadHash: diagnosticIdSchema.optional(),
  turnHash: diagnosticIdSchema.optional(),
  itemHash: diagnosticIdSchema.optional(),
  requestHash: diagnosticIdSchema.optional(),
  commandHash: diagnosticIdSchema.optional(),
  mutationHash: diagnosticIdSchema.optional(),
  childThreadHash: diagnosticIdSchema.optional(),
  clientType: SyncV4DiagnosticClientTypeSchema.optional(),
  softwareVersion: stableVersionSchema.optional(),
  codexVersion: stableVersionSchema.optional(),
  protocolVersion: z.literal(4).optional(),
  featureEnabled: z.boolean().optional(),
  transportSecurity: SyncV4DiagnosticTransportSecuritySchema.optional(),
  transportOperation: SyncV4DiagnosticTransportOperationSchema.optional(),
  rpcFamily: SyncV4DiagnosticRpcFamilySchema.optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  entityType: CodexEntityTypeSchema.optional(),
  mutationOperation: z.enum(['upsert', 'delete']).optional(),
  state: SyncV4DiagnosticStateSchema.optional(),
  source: SyncV4DiagnosticSourceSchema.optional(),
  reason: SyncV4DiagnosticReasonSchema.optional(),
  errorKind: SyncV4DiagnosticErrorKindSchema.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  seq: nonnegativeIntegerSchema.optional(),
  cursor: nonnegativeIntegerSchema.optional(),
  highWatermark: nonnegativeIntegerSchema.optional(),
  revision: nonnegativeIntegerSchema.optional(),
  count: nonnegativeIntegerSchema.optional(),
  accepted: nonnegativeIntegerSchema.optional(),
  duplicate: nonnegativeIntegerSchema.optional(),
  superseded: nonnegativeIntegerSchema.optional(),
  depth: nonnegativeIntegerSchema.optional(),
  ageMs: nonnegativeIntegerSchema.optional(),
  durationMs: nonnegativeIntegerSchema.optional(),
  bytes: nonnegativeIntegerSchema.optional(),
  attempt: nonnegativeIntegerSchema.optional(),
  page: nonnegativeIntegerSchema.optional(),
  generation: nonnegativeIntegerSchema.optional(),
  epoch: nonnegativeIntegerSchema.optional(),
  pending: nonnegativeIntegerSchema.optional(),
  dropped: nonnegativeIntegerSchema.optional(),
  suppressed: nonnegativeIntegerSchema.optional(),
  invalid: nonnegativeIntegerSchema.optional(),
  writeFailures: nonnegativeIntegerSchema.optional(),
  listenerFailures: nonnegativeIntegerSchema.optional(),
}).strict();
export type SyncV4DiagnosticRecord = z.infer<typeof SyncV4DiagnosticRecordSchema>;

export type SyncV4DiagnosticInput = Omit<
  SyncV4DiagnosticRecord,
  'schemaVersion' | 'timestamp'
> & {
  timestamp?: number;
};

export interface SyncV4DiagnosticSink {
  record(input: SyncV4DiagnosticInput): void;
}

export function recordSyncV4DiagnosticSafely(
  sink: SyncV4DiagnosticSink | null | undefined,
  input: SyncV4DiagnosticInput,
): boolean {
  if (!sink) return false;
  try {
    sink.record(input);
    return true;
  } catch {
    return false;
  }
}

export function isSyncV4TraceId(value: unknown): value is string {
  return SyncV4TraceIdSchema.safeParse(value).success;
}

export function requireSyncV4TraceId(value: string): string {
  if (!isSyncV4TraceId(value)) {
    throw new Error('Sync v4 trace ID must be 128-bit lowercase hex');
  }
  return value;
}

export function requireSyncV4TraceEcho(
  expectedTraceId: string | undefined,
  echoedTraceId: unknown,
): void {
  if (expectedTraceId === undefined) return;
  requireSyncV4TraceId(expectedTraceId);
  if (echoedTraceId !== expectedTraceId) {
    const error = new Error('Sync v4 trace echo did not match the request');
    error.name = 'SyncV4ProtocolError';
    throw error;
  }
}

export function createSyncV4DiagnosticRecord(
  input: SyncV4DiagnosticInput,
  now: () => number = Date.now,
): SyncV4DiagnosticRecord {
  const record = SyncV4DiagnosticRecordSchema.parse({
    ...input,
    schemaVersion: SYNC_V4_DIAGNOSTIC_SCHEMA_VERSION,
    timestamp: input.timestamp ?? now(),
  });
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > MAX_SYNC_V4_DIAGNOSTIC_RECORD_BYTES) {
    throw new Error('Sync v4 diagnostic record exceeds the byte limit');
  }
  return record;
}

export function classifySyncV4DiagnosticError(error: unknown): SyncV4DiagnosticErrorKind {
  try {
    const value = objectRecord(error);
    const response = objectRecord(value.response);
    const directStatus = typeof value.statusCode === 'number' ? value.statusCode : null;
    const responseStatus = typeof response.status === 'number' ? response.status : null;
    const status = directStatus ?? responseStatus;
    if (status === 400 || status === 413 || status === 422) return 'validation';
    if (status === 401) return 'authentication';
    if (status === 403) return 'authorization';
    if (status === 404) return 'notFound';
    if (status === 408) return 'timeout';
    if (status === 409) return 'conflict';
    if (status === 426) return 'protocol';
    if (status === 429) return 'rateLimited';
    if (status !== null && status >= 500) return 'server';

    const name = typeof value.name === 'string' ? value.name : '';
    const code = typeof value.code === 'string' ? value.code : '';
    if (name === 'AbortError' || code === 'ERR_CANCELED') return 'cancelled';
    if (
      code === 'ETIMEDOUT'
      || code === 'ESOCKETTIMEDOUT'
      || code === 'ECONNABORTED'
      || name === 'TimeoutError'
    ) return 'timeout';
    if (
      code === 'ECONNRESET'
      || code === 'ECONNREFUSED'
      || code === 'ENETUNREACH'
      || code === 'ENOTFOUND'
      || code === 'EAI_AGAIN'
      || code === 'ERR_NETWORK'
    ) return 'network';
    if (name === 'ZodError' || name === 'SyntaxError') return 'validation';
    if (name.includes('Conflict')) return 'conflict';
    if (name.includes('Decrypt') || name.includes('Crypto')) return 'crypto';
    if (name.includes('Journal') || code === 'EIO' || code === 'ENOSPC') return 'storage';
    if (name.includes('Projection')) return 'projection';
    if (name.includes('Protocol') || name.includes('Rpc')) return 'protocol';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
