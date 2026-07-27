import * as z from 'zod';
import { CodexEntityTypeSchema, syncV4Utf8ByteLength } from './syncV4';

export const CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION = 1;
export const MAX_CODEX_SYNC_V4_PART_BYTES = 64 * 1024;

const idSchema = z.string().min(1).max(512);
const timestampSchema = z.number().int().nonnegative();
const nullableTimestampSchema = timestampSchema.nullable();
const jsonSchema = z.json();

const entityBaseShape = {
  schemaVersion: z.literal(CODEX_SYNC_V4_ENTITY_SCHEMA_VERSION),
  providerId: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const CodexThreadStatusV4Schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notLoaded') }).strict(),
  z.object({ type: z.literal('idle') }).strict(),
  z.object({ type: z.literal('systemError') }).strict(),
  z.object({
    type: z.literal('active'),
    activeFlags: z.array(z.enum(['waitingOnApproval', 'waitingOnUserInput'])),
  }).strict(),
]);
export type CodexThreadStatusV4 = z.infer<typeof CodexThreadStatusV4Schema>;

export const CodexTokenUsageBreakdownV4Schema = z.object({
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
}).strict();

export const CodexThreadTokenUsageV4Schema = z.object({
  total: CodexTokenUsageBreakdownV4Schema,
  last: CodexTokenUsageBreakdownV4Schema,
  modelContextWindow: z.number().int().positive().nullable(),
}).strict();

export const CodexThreadGoalV4Schema = z.object({
  objective: z.string().min(1),
  status: z.enum(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']),
  tokenBudget: z.number().int().nonnegative().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type CodexThreadGoalV4 = z.infer<typeof CodexThreadGoalV4Schema>;

export const CodexThreadEntityV4Schema = z.object({
  ...entityBaseShape,
  entityType: z.literal('codex.thread'),
  threadId: idSchema,
  sessionTreeId: idSchema.nullable(),
  forkedFromThreadId: idSchema.nullable(),
  parentThreadId: idSchema.nullable(),
  name: z.string().nullable(),
  preview: z.string(),
  cwd: z.string(),
  cliVersion: z.string(),
  model: z.string().nullable(),
  modelProvider: z.string(),
  source: jsonSchema,
  status: CodexThreadStatusV4Schema,
  canAcceptDirectInput: z.boolean().nullable(),
  settings: z.object({
    approvalPolicy: jsonSchema.nullable(),
    approvalsReviewer: jsonSchema.nullable(),
    sandboxPolicy: jsonSchema.nullable(),
    permissionProfile: jsonSchema.nullable(),
    serviceTier: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
    reasoningSummary: z.string().nullable(),
    collaborationMode: jsonSchema.nullable(),
    personality: z.string().nullable(),
  }).strict(),
  goal: CodexThreadGoalV4Schema.nullable(),
  tokenUsage: CodexThreadTokenUsageV4Schema.nullable(),
}).strict();
export type CodexThreadEntityV4 = z.infer<typeof CodexThreadEntityV4Schema>;

export const CodexRuntimeEntityV4Schema = z.object({
  ...entityBaseShape,
  entityType: z.literal('codex.runtime'),
  threadId: idSchema,
  connection: z.enum(['connecting', 'connected', 'disconnected', 'error']),
  execution: CodexThreadStatusV4Schema,
  statusUnknown: z.boolean(),
  protocolVersion: z.string(),
  codexCliVersion: z.string(),
  syncState: z.enum(['pending', 'importing', 'ready', 'error']),
  pendingApprovalCount: z.number().int().nonnegative(),
  pendingUserInputCount: z.number().int().nonnegative(),
  activeSubagentCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  lastKnownAt: timestampSchema,
}).strict();
export type CodexRuntimeEntityV4 = z.infer<typeof CodexRuntimeEntityV4Schema>;

export const CodexTurnEntityV4Schema = z.object({
  ...entityBaseShape,
  entityType: z.literal('codex.turn'),
  threadId: idSchema,
  turnId: idSchema,
  status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  error: z.object({
    message: z.string(),
    code: z.string().nullable(),
    details: z.string().nullable(),
  }).strict().nullable(),
  usage: CodexTokenUsageBreakdownV4Schema.nullable(),
  planRevision: z.number().int().nonnegative(),
  diffRevision: z.number().int().nonnegative(),
}).strict();
export type CodexTurnEntityV4 = z.infer<typeof CodexTurnEntityV4Schema>;

export const CodexItemEntityV4Schema = z.object({
  ...entityBaseShape,
  entityType: z.literal('codex.item'),
  threadId: idSchema,
  turnId: idSchema,
  itemId: idSchema,
  itemType: z.string().min(1).max(128),
  status: z.string().min(1).max(128).nullable(),
  parentItemId: idSchema.nullable(),
  clientId: idSchema.nullable(),
  phase: z.string().max(128).nullable(),
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema,
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  processId: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  server: z.string().nullable(),
  tool: z.string().nullable(),
  arguments: jsonSchema.nullable(),
}).strict();
export type CodexItemEntityV4 = z.infer<typeof CodexItemEntityV4Schema>;

export const CodexPartKindV4Schema = z.enum([
  'text',
  'reasoningSummary',
  'commandOutput',
  'patch',
  'mcpProgress',
  'plan',
  'userInput',
  'warning',
  'error',
]);
export type CodexPartKindV4 = z.infer<typeof CodexPartKindV4Schema>;

export const CodexPartEntityV4Schema = z.object({
  ...entityBaseShape,
  entityType: z.literal('codex.part'),
  threadId: idSchema,
  turnId: idSchema,
  itemId: idSchema,
  partId: idSchema,
  kind: CodexPartKindV4Schema,
  index: z.number().int().nonnegative(),
  chunkIndex: z.number().int().nonnegative(),
  content: z.string().refine(
    (value) => syncV4Utf8ByteLength(value) <= MAX_CODEX_SYNC_V4_PART_BYTES,
    `part content exceeds ${MAX_CODEX_SYNC_V4_PART_BYTES} UTF-8 bytes`,
  ),
  contentType: z.enum(['text', 'json']),
  final: z.boolean(),
}).strict();
export type CodexPartEntityV4 = z.infer<typeof CodexPartEntityV4Schema>;

export const CodexRequestEntityV4Schema = z.object({
  ...entityBaseShape,
  entityType: z.literal('codex.request'),
  requestId: idSchema,
  threadId: idSchema,
  turnId: idSchema.nullable(),
  itemId: idSchema.nullable(),
  requestType: z.enum(['commandApproval', 'fileChangeApproval', 'permissions', 'toolUserInput']),
  status: z.enum(['pending', 'accepted', 'declined', 'cancelled', 'resolved', 'error']),
  title: z.string().nullable(),
  prompt: z.string().nullable(),
  options: jsonSchema.nullable(),
  response: jsonSchema.nullable(),
  resolvedAt: nullableTimestampSchema,
}).strict();
export type CodexRequestEntityV4 = z.infer<typeof CodexRequestEntityV4Schema>;

export const CodexCommandEntityV4Schema = z.object({
  ...entityBaseShape,
  entityType: z.literal('codex.command'),
  commandId: idSchema,
  threadId: idSchema.nullable(),
  expectedTurnId: idSchema.nullable(),
  command: z.string().min(1).max(128),
  payload: jsonSchema,
  clientUserMessageId: idSchema,
  replacesCommandId: idSchema.nullable(),
}).strict();
export type CodexCommandEntityV4 = z.infer<typeof CodexCommandEntityV4Schema>;

export const CodexCommandResultEntityV4Schema = z.object({
  ...entityBaseShape,
  entityType: z.literal('codex.commandResult'),
  commandId: idSchema,
  threadId: idSchema.nullable(),
  turnId: idSchema.nullable(),
  status: z.enum(['received', 'executing', 'succeeded', 'failed', 'resultUnknown', 'notReplayed']),
  providerRequestId: idSchema.nullable(),
  result: jsonSchema.nullable(),
  error: z.string().nullable(),
}).strict();
export type CodexCommandResultEntityV4 = z.infer<typeof CodexCommandResultEntityV4Schema>;

export const CodexRelationEntityV4Schema = z.object({
  ...entityBaseShape,
  entityType: z.literal('codex.relation'),
  parentThreadId: idSchema,
  childThreadId: idSchema,
  parentTurnId: idSchema.nullable(),
  delegationItemId: idSchema.nullable(),
  parentSessionId: idSchema,
  childSessionId: idSchema,
  depth: z.number().int().nonnegative(),
  status: z.enum(['starting', 'active', 'completed', 'failed', 'interrupted']),
}).strict();
export type CodexRelationEntityV4 = z.infer<typeof CodexRelationEntityV4Schema>;

export const CodexEntityV4Schema = z.discriminatedUnion('entityType', [
  CodexThreadEntityV4Schema,
  CodexRuntimeEntityV4Schema,
  CodexTurnEntityV4Schema,
  CodexItemEntityV4Schema,
  CodexPartEntityV4Schema,
  CodexRequestEntityV4Schema,
  CodexCommandEntityV4Schema,
  CodexCommandResultEntityV4Schema,
  CodexRelationEntityV4Schema,
]);
export type CodexEntityV4 = z.infer<typeof CodexEntityV4Schema>;

export const SyncV4AadSchema = z.object({
  sessionId: idSchema,
  entityId: idSchema,
  entityType: CodexEntityTypeSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  op: z.enum(['upsert', 'delete']),
}).strict();
export type SyncV4Aad = z.infer<typeof SyncV4AadSchema>;

export function encodeSyncV4Aad(value: SyncV4Aad): string {
  return JSON.stringify([
    'happy-sync-v4-aad',
    value.sessionId,
    value.entityId,
    value.entityType,
    value.revision,
    value.op,
  ]);
}

export function encodeSyncV4OpaqueEntityIdInput(entityType: z.infer<typeof CodexEntityTypeSchema>, providerId: string): string {
  return JSON.stringify(['happy-sync-v4-entity-id', entityType, providerId]);
}
