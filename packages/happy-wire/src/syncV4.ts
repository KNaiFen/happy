import * as z from 'zod';

export const MAX_SYNC_V4_MUTATIONS_PER_BATCH = 100;
export const MAX_SYNC_V4_CHANGES_PER_PAGE = 100;
export const MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE = 100;
export const MAX_SYNC_V4_CIPHERTEXT_LENGTH = 256 * 1024;
export const MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH = 4 * 1024 * 1024;
export const MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH = 4 * 1024 * 1024;
export const MAX_SYNC_V4_CURSOR_LENGTH = 512;
export const MAX_SYNC_V4_DATABASE_INTEGER = 2_147_483_647;
export const CODEX_SYNC_V4_PROTOCOL_VERSION = 4 as const;

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseStableVersion(value: string): [number, number, number] | null {
  const match = stableVersionPattern.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger)
    ? [parts[0], parts[1], parts[2]]
    : null;
}

const SyncV4StableVersionSchema = z.string().superRefine((value, context) => {
  if (parseStableVersion(value)) return;
  context.addIssue({
    code: 'custom',
    message: 'version must be a canonical three-part stable SemVer',
  });
});

export const SyncV4CapabilitiesSchema = z.object({
  codex: z.object({
    enabled: z.boolean(),
    protocolVersion: z.literal(CODEX_SYNC_V4_PROTOCOL_VERSION),
    minimumHappyCliVersion: SyncV4StableVersionSchema,
    minimumHappyAppVersion: SyncV4StableVersionSchema,
    minimumHappyAgentVersion: SyncV4StableVersionSchema,
    minimumCodexCliVersion: SyncV4StableVersionSchema,
  }).strict(),
}).strict();
export type SyncV4Capabilities = z.infer<typeof SyncV4CapabilitiesSchema>;

export function isSyncV4VersionAtLeast(current: string, minimum: string): boolean {
  const currentParts = parseStableVersion(current);
  const minimumParts = parseStableVersion(minimum);
  if (!currentParts || !minimumParts) return false;

  for (let index = 0; index < 3; index += 1) {
    const currentPart = currentParts[index];
    const minimumPart = minimumParts[index];
    if (currentPart !== minimumPart) return currentPart > minimumPart;
  }
  return true;
}

const utf8Encoder = new TextEncoder();

export function syncV4Utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

const SyncCiphertextV4Schema = z.string().min(1).superRefine((value, context) => {
  if (value.length > MAX_SYNC_V4_CIPHERTEXT_LENGTH) {
    context.addIssue({
      code: 'too_big',
      origin: 'string',
      maximum: MAX_SYNC_V4_CIPHERTEXT_LENGTH,
      inclusive: true,
      message: `ciphertext exceeds ${MAX_SYNC_V4_CIPHERTEXT_LENGTH} characters`,
    });
    return;
  }
  if (syncV4Utf8ByteLength(value) > MAX_SYNC_V4_CIPHERTEXT_LENGTH) {
    context.addIssue({
      code: 'custom',
      message: `ciphertext exceeds ${MAX_SYNC_V4_CIPHERTEXT_LENGTH} UTF-8 bytes`,
    });
  }
});

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
  revision: z.number().int().positive().max(MAX_SYNC_V4_DATABASE_INTEGER),
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

  let ciphertextLength = 0;
  for (const mutation of value.mutations) {
    ciphertextLength += syncV4Utf8ByteLength(mutation.ciphertext);
    if (ciphertextLength > MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH) break;
  }
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
  seq: z.number().int().positive().max(MAX_SYNC_V4_DATABASE_INTEGER),
  revision: z.number().int().positive().max(MAX_SYNC_V4_DATABASE_INTEGER),
  status: SyncAckStatusV4Schema,
}).strict();
export type SyncAckV4 = z.infer<typeof SyncAckV4Schema>;

export const SyncMutationBatchResponseV4Schema = z.object({
  acknowledgements: z.array(SyncAckV4Schema).min(1).max(MAX_SYNC_V4_MUTATIONS_PER_BATCH),
}).strict();
export type SyncMutationBatchResponseV4 = z.infer<typeof SyncMutationBatchResponseV4Schema>;

export const SyncChangeV4Schema = SyncMutationV4Schema.extend({
  seq: z.number().int().positive().max(MAX_SYNC_V4_DATABASE_INTEGER),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type SyncChangeV4 = z.infer<typeof SyncChangeV4Schema>;

export const SyncChangesResponseV4Schema = z.object({
  changes: z.array(SyncChangeV4Schema).max(MAX_SYNC_V4_CHANGES_PER_PAGE),
  hasMore: z.boolean(),
  highWatermark: z.number().int().nonnegative().max(MAX_SYNC_V4_DATABASE_INTEGER),
}).strict().superRefine((value, context) => {
  let previousSeq = 0;
  let ciphertextLength = 0;
  value.changes.forEach((change, index) => {
    if (index > 0 && change.seq !== previousSeq + 1) {
      context.addIssue({
        code: 'custom',
        message: 'change seq values must be contiguous',
        path: ['changes', index, 'seq'],
      });
    }
    if (change.seq > value.highWatermark) {
      context.addIssue({
        code: 'custom',
        message: 'change seq cannot exceed highWatermark',
        path: ['changes', index, 'seq'],
      });
    }
    previousSeq = change.seq;
    ciphertextLength += syncV4Utf8ByteLength(change.ciphertext);
  });
  if (ciphertextLength > MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH) {
    context.addIssue({
      code: 'custom',
      message: `aggregate ciphertext exceeds ${MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH} bytes`,
      path: ['changes'],
    });
  }
});
export type SyncChangesResponseV4 = z.infer<typeof SyncChangesResponseV4Schema>;

export const SyncEntitySnapshotV4Schema = SyncMutationV4Schema.omit({ mutationId: true }).extend({
  updatedSeq: z.number().int().positive().max(MAX_SYNC_V4_DATABASE_INTEGER),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type SyncEntitySnapshotV4 = z.infer<typeof SyncEntitySnapshotV4Schema>;

export const SyncSnapshotResponseV4Schema = z.object({
  entities: z.array(SyncEntitySnapshotV4Schema).max(MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE),
  highWatermark: z.number().int().nonnegative().max(MAX_SYNC_V4_DATABASE_INTEGER),
  nextCursor: z.string().min(1).max(MAX_SYNC_V4_CURSOR_LENGTH).nullable(),
}).strict().superRefine((value, context) => {
  const entityIds = new Set<string>();
  let ciphertextLength = 0;
  value.entities.forEach((entity, index) => {
    if (entityIds.has(entity.entityId)) {
      context.addIssue({
        code: 'custom',
        message: 'snapshot entity IDs must be unique within a page',
        path: ['entities', index, 'entityId'],
      });
    }
    if (entity.updatedSeq > value.highWatermark) {
      context.addIssue({
        code: 'custom',
        message: 'entity updatedSeq cannot exceed highWatermark',
        path: ['entities', index, 'updatedSeq'],
      });
    }
    entityIds.add(entity.entityId);
    ciphertextLength += syncV4Utf8ByteLength(entity.ciphertext);
  });
  if (value.nextCursor !== null && value.entities.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'nextCursor requires a non-empty entity page',
      path: ['nextCursor'],
    });
  }
  if (ciphertextLength > MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH) {
    context.addIssue({
      code: 'custom',
      message: `aggregate ciphertext exceeds ${MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH} bytes`,
      path: ['entities'],
    });
  }
});
export type SyncSnapshotResponseV4 = z.infer<typeof SyncSnapshotResponseV4Schema>;

export const SyncSnapshotRequiredV4Schema = z.object({
  error: z.literal('snapshotRequired'),
  minimumSeq: z.number().int().nonnegative().max(MAX_SYNC_V4_DATABASE_INTEGER),
  highWatermark: z.number().int().nonnegative().max(MAX_SYNC_V4_DATABASE_INTEGER),
}).strict().superRefine((value, context) => {
  if (value.minimumSeq > value.highWatermark + 1) {
    context.addIssue({
      code: 'custom',
      message: 'minimumSeq cannot exceed highWatermark + 1',
      path: ['minimumSeq'],
    });
  }
});
export type SyncSnapshotRequiredV4 = z.infer<typeof SyncSnapshotRequiredV4Schema>;

export const SyncInvalidationV4Schema = z.object({
  sessionId: z.string().min(1),
  highWatermark: z.number().int().nonnegative().max(MAX_SYNC_V4_DATABASE_INTEGER),
}).strict();
export type SyncInvalidationV4 = z.infer<typeof SyncInvalidationV4Schema>;
