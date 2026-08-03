import { describe, expect, it } from 'vitest';
import {
  MAX_SYNC_V4_BATCH_CIPHERTEXT_LENGTH,
  MAX_SYNC_V4_CIPHERTEXT_LENGTH,
  MAX_SYNC_V4_DATABASE_INTEGER,
  MAX_SYNC_V4_MUTATIONS_PER_BATCH,
  MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH,
  isSyncV4VersionAtLeast,
  SyncAckV4Schema,
  SyncChangesResponseV4Schema,
  SyncV4CapabilitiesSchema,
  SyncMutationBatchV4Schema,
  SyncMutationBatchResponseV4Schema,
  SyncMutationV4Schema,
  SyncSnapshotResponseV4Schema,
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
  it('describes the coordinated Codex compatibility set', () => {
    expect(SyncV4CapabilitiesSchema.parse({
      codex: {
        enabled: true,
        protocolVersion: 4,
        minimumHappyCliVersion: '1.4.2',
        minimumHappyAppVersion: '1.11.4',
        minimumHappyAgentVersion: '0.1.3',
        minimumCodexCliVersion: '0.145.0',
      },
    }).codex.enabled).toBe(true);

    expect(() => SyncV4CapabilitiesSchema.parse({
      codex: {
        enabled: true,
        protocolVersion: 4,
        minimumHappyCliVersion: 'latest',
        minimumHappyAppVersion: '1.11.4',
        minimumHappyAgentVersion: '0.1.3',
        minimumCodexCliVersion: '0.145.0',
      },
    })).toThrow();
  });

  it('compares stable compatibility versions without accepting ambiguous tags', () => {
    expect(isSyncV4VersionAtLeast('1.4.2', '1.4.2')).toBe(true);
    expect(isSyncV4VersionAtLeast('1.5.0', '1.4.2')).toBe(true);
    expect(isSyncV4VersionAtLeast('2.0.0', '1.99.99')).toBe(true);
    expect(isSyncV4VersionAtLeast('1.4.1', '1.4.2')).toBe(false);
    expect(isSyncV4VersionAtLeast('1.4.2-beta.1', '1.4.2')).toBe(false);
    expect(isSyncV4VersionAtLeast('01.4.2', '1.4.2')).toBe(false);
    expect(isSyncV4VersionAtLeast('9007199254740992.0.0', '1.4.2')).toBe(false);
    expect(isSyncV4VersionAtLeast('invalid', '1.4.2')).toBe(false);

    expect(SyncV4CapabilitiesSchema.safeParse({
      codex: {
        enabled: true,
        protocolVersion: 4,
        minimumHappyCliVersion: '01.4.2',
        minimumHappyAppVersion: '1.11.4',
        minimumHappyAgentVersion: '0.1.3',
        minimumCodexCliVersion: '0.145.0',
      },
    }).success).toBe(false);
  });

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

    expect(SyncMutationV4Schema.safeParse({
      ...mutation,
      revision: MAX_SYNC_V4_DATABASE_INTEGER + 1,
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

  it('limits response pages and enforces watermark invariants', () => {
    const change = { ...mutation, seq: 1, createdAt: 1 };
    expect(SyncChangesResponseV4Schema.parse({
      changes: [change, { ...change, mutationId: 'mutation-2', seq: 2 }],
      hasMore: false,
      highWatermark: 2,
    }).changes).toHaveLength(2);

    expect(SyncChangesResponseV4Schema.safeParse({
      changes: [{ ...change, seq: 2 }, { ...change, mutationId: 'mutation-2', seq: 1 }],
      hasMore: false,
      highWatermark: 2,
    }).success).toBe(false);
    expect(SyncChangesResponseV4Schema.safeParse({
      changes: [change, { ...change, mutationId: 'mutation-2', seq: 3 }],
      hasMore: false,
      highWatermark: 3,
    }).success).toBe(false);
    expect(SyncChangesResponseV4Schema.safeParse({
      changes: [{ ...change, seq: 3 }],
      hasMore: false,
      highWatermark: 2,
    }).success).toBe(false);

    expect(SyncSnapshotResponseV4Schema.safeParse({
      entities: [],
      highWatermark: 2,
      nextCursor: '2:entity',
    }).success).toBe(false);
    expect(SyncSnapshotResponseV4Schema.safeParse({
      entities: [{
        ...mutation,
        mutationId: undefined,
        updatedSeq: 3,
        createdAt: 1,
        updatedAt: 1,
      }],
      highWatermark: 2,
      nextCursor: null,
    }).success).toBe(false);
  });

  it('caps acknowledgement count and aggregate response ciphertext', () => {
    const ack = { mutationId: 'mutation-1', seq: 1, revision: 1, status: 'accepted' as const };
    expect(SyncMutationBatchResponseV4Schema.safeParse({
      acknowledgements: Array.from({ length: MAX_SYNC_V4_MUTATIONS_PER_BATCH + 1 }, (_, index) => ({
        ...ack,
        mutationId: `mutation-${index}`,
        seq: index + 1,
      })),
    }).success).toBe(false);

    const largeCiphertext = 'x'.repeat(MAX_SYNC_V4_CIPHERTEXT_LENGTH);
    const count = Math.floor(MAX_SYNC_V4_RESPONSE_CIPHERTEXT_LENGTH / largeCiphertext.length) + 1;
    expect(SyncChangesResponseV4Schema.safeParse({
      changes: Array.from({ length: count }, (_, index) => ({
        ...mutation,
        mutationId: `mutation-${index}`,
        entityId: `entity-${index}`,
        ciphertext: largeCiphertext,
        seq: index + 1,
        createdAt: 1,
      })),
      hasMore: false,
      highWatermark: count,
    }).success).toBe(false);
  });
});
