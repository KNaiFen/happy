import * as z from 'zod';

export const MAX_SYNC_V4_MUTATIONS_PER_BATCH = 100;
export const MAX_SYNC_V4_CIPHERTEXT_LENGTH = 256 * 1024;
export const MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH = 4 * 1024 * 1024;

const utf8Encoder = new TextEncoder();

export function syncV4Utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

const SyncCiphertextV4Schema = z.string()
  .min(1)
  .max(MAX_SYNC_V4_CIPHERTEXT_LENGTH)
  .refine(
    (value) => syncV4Utf8ByteLength(value) <= MAX_SYNC_V4_CIPHERTEXT_LENGTH,
    `ciphertext exceeds ${MAX_SYNC_V4_CIPHERTEXT_LENGTH} UTF-8 bytes`,
  );

export const CodexEntityTypeSchema = z.enum([
  'codex.thread',
  'codex.runtime',
  'codex.turn',
  'codex.item',
  'codex.part',
  'codex.request',
  'codex.command',
  'codex.commandResult',
  'codex.relation',
]);
export type CodexEntityType = z.infer<typeof CodexEntityTypeSchema>;

export const SyncMutationOperationV4Schema = z.enum(['upsert', 'delete']);
export type SyncMutationOperationV4 = z.infer<typeof SyncMutationOperationV4Schema>;

export const SyncMutationV4Schema = z.object({
  mutationId: z.string().min(1).max(200),
  producerId: z.string().min(1).max(200),
  entityId: z.string().min(1).max(200),
  entityType: CodexEntityTypeSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  op: SyncMutationOperationV4Schema,
  ciphertext: SyncCiphertextV4Schema,
}).strict();
export type SyncMutationV4 = z.infer<typeof SyncMutationV4Schema>;

export const SyncMutationBatchV4Schema = z.object({
  mutations: z.array(SyncMutationV4Schema).min(1).max(MAX_SYNC_V4_MUTATIONS_PER_BATCH),
}).strict().superRefine((value, context) => {
  const mutationIds = new Set<string>();
  for (let index = 0; index < value.mutations.length; index += 1) {
    const mutationId = value.mutations[index].mutationId;
    if (mutationIds.has(mutationId)) {
      context.addIssue({
        code: 'custom',
        message: 'mutationId must be unique within a batch',
        path: ['mutations', index, 'mutationId'],
      });
    }
    mutationIds.add(mutationId);
  }

  const ciphertextLength = value.mutations.reduce(
    (total, mutation) => total + syncV4Utf8ByteLength(mutation.ciphertext),
    0,
  );
  if (ciphertextLength > MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH) {
    context.addIssue({
      code: 'custom',
      message: `aggregate ciphertext exceeds ${MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH} bytes`,
      path: ['mutations'],
    });
  }
});
export type SyncMutationBatchV4 = z.infer<typeof SyncMutationBatchV4Schema>;

export const SyncAckStatusV4Schema = z.enum(['accepted', 'duplicate', 'superseded']);
export type SyncAckStatusV4 = z.infer<typeof SyncAckStatusV4Schema>;

export const SyncAckV4Schema = z.object({
  mutationId: z.string().min(1).max(200),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: SyncAckStatusV4Schema,
}).strict();
export type SyncAckV4 = z.infer<typeof SyncAckV4Schema>;

export const SyncMutationBatchResponseV4Schema = z.object({
  acknowledgements: z.array(SyncAckV4Schema),
}).strict();
export type SyncMutationBatchResponseV4 = z.infer<typeof SyncMutationBatchResponseV4Schema>;

export const SyncChangeV4Schema = SyncMutationV4Schema.extend({
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type SyncChangeV4 = z.infer<typeof SyncChangeV4Schema>;

export const SyncChangesResponseV4Schema = z.object({
  changes: z.array(SyncChangeV4Schema),
  hasMore: z.boolean(),
  highWatermark: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type SyncChangesResponseV4 = z.infer<typeof SyncChangesResponseV4Schema>;

export const SyncEntitySnapshotV4Schema = SyncMutationV4Schema.omit({ mutationId: true }).extend({
  updatedSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type SyncEntitySnapshotV4 = z.infer<typeof SyncEntitySnapshotV4Schema>;

export const SyncSnapshotResponseV4Schema = z.object({
  entities: z.array(SyncEntitySnapshotV4Schema),
  highWatermark: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextCursor: z.string().min(1).nullable(),
}).strict();
export type SyncSnapshotResponseV4 = z.infer<typeof SyncSnapshotResponseV4Schema>;

export const SyncSnapshotRequiredV4Schema = z.object({
  error: z.literal('snapshotRequired'),
  minimumSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  highWatermark: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type SyncSnapshotRequiredV4 = z.infer<typeof SyncSnapshotRequiredV4Schema>;

export const SyncInvalidationV4Schema = z.object({
  sessionId: z.string().min(1),
  highWatermark: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type SyncInvalidationV4 = z.infer<typeof SyncInvalidationV4Schema>;
