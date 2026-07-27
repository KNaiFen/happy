import { describe, expect, it } from 'vitest';
import {
  MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH,
  MAX_SYNC_V4_CIPHERTEXT_LENGTH,
  SyncAckV4Schema,
  SyncMutationBatchV4Schema,
  SyncMutationV4Schema,
} from './syncV4';

const mutation = {
  mutationId: 'mutation-1',
  producerId: 'producer-1',
  entityId: 'opaque-entity-1',
  entityType: 'codex.item' as const,
  revision: 1,
  op: 'upsert' as const,
  ciphertext: 'encrypted-content',
};

describe('Sync v4 wire schemas', () => {
  it('accepts a valid encrypted Codex entity mutation', () => {
    expect(SyncMutationV4Schema.parse(mutation)).toEqual(mutation);
  });

  it('rejects unknown entity types and oversized ciphertext', () => {
    expect(SyncMutationV4Schema.safeParse({
      ...mutation,
      entityType: 'claude.message',
    }).success).toBe(false);

    expect(SyncMutationV4Schema.safeParse({
      ...mutation,
      ciphertext: 'x'.repeat(MAX_SYNC_V4_CIPHERTEXT_LENGTH + 1),
    }).success).toBe(false);

    expect(SyncMutationV4Schema.safeParse({
      ...mutation,
      ciphertext: '\u754c'.repeat(Math.floor(MAX_SYNC_V4_CIPHERTEXT_LENGTH / 3) + 1),
    }).success).toBe(false);
  });

  it('limits batches by mutation count and aggregate ciphertext size', () => {
    expect(SyncMutationBatchV4Schema.safeParse({
      mutations: [mutation, mutation],
    }).success).toBe(false);

    expect(SyncMutationBatchV4Schema.safeParse({
      mutations: Array.from({ length: 101 }, (_, index) => ({
        ...mutation,
        mutationId: `mutation-${index}`,
      })),
    }).success).toBe(false);

    const perMutationLength = MAX_SYNC_V4_CIPHERTEXT_LENGTH;
    const oversizedBatchCount = Math.floor(MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH / perMutationLength) + 1;
    expect(SyncMutationBatchV4Schema.safeParse({
      mutations: Array.from({ length: oversizedBatchCount }, (_, index) => ({
        ...mutation,
        mutationId: `large-${index}`,
        ciphertext: 'x'.repeat(perMutationLength),
      })),
    }).success).toBe(false);
  });

  it('keeps send acknowledgements independent from receive cursors', () => {
    const ack = {
      mutationId: 'mutation-1',
      seq: 12,
      revision: 1,
      status: 'accepted' as const,
    };
    expect(SyncAckV4Schema.parse(ack)).toEqual(ack);
    expect(SyncAckV4Schema.safeParse({ ...ack, receiveCursor: 12 }).success).toBe(false);
  });
});
