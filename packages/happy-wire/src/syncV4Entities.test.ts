import { describe, expect, it } from 'vitest';
import {
  CodexEntityV4Schema,
  CodexPartEntityV4Schema,
  CodexThreadGoalV4Schema,
  MAX_CODEX_SYNC_V4_PART_BYTES,
  encodeSyncV4Aad,
  encodeSyncV4OpaqueEntityIdInput,
} from './syncV4Entities';

const part = {
  schemaVersion: 1,
  entityType: 'codex.part' as const,
  providerId: 'part-1',
  createdAt: 10,
  updatedAt: 11,
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  partId: 'part-1',
  kind: 'reasoningSummary' as const,
  index: 0,
  chunkIndex: 0,
  content: 'Checked the synchronization path.',
  contentType: 'text' as const,
  final: false,
};

describe('Codex Sync v4 entity schemas', () => {
  it('keeps official goal progress in the recoverable thread projection', () => {
    expect(CodexThreadGoalV4Schema.parse({
      objective: 'finish sync v4',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 12,
      timeUsedSeconds: 3,
      createdAt: 10,
      updatedAt: 11,
    })).toMatchObject({ objective: 'finish sync v4', status: 'active' });
  });

  it('accepts official reasoning summaries as ordered parts', () => {
    expect(CodexEntityV4Schema.parse(part)).toEqual(part);
  });

  it('does not define a raw reasoning part type', () => {
    expect(CodexPartEntityV4Schema.safeParse({
      ...part,
      kind: 'rawReasoning',
    }).success).toBe(false);
  });

  it('enforces the 64 KiB UTF-8 part boundary', () => {
    expect(CodexPartEntityV4Schema.safeParse({
      ...part,
      content: '\u754c'.repeat(Math.floor(MAX_CODEX_SYNC_V4_PART_BYTES / 3) + 1),
    }).success).toBe(false);
  });

  it('encodes deterministic domain-separated AAD and opaque-id input', () => {
    expect(encodeSyncV4Aad({
      sessionId: 'session-1',
      entityId: 'opaque-1',
      entityType: 'codex.item',
      revision: 3,
      op: 'upsert',
    })).toBe('["happy-sync-v4-aad","session-1","opaque-1","codex.item",3,"upsert"]');
    expect(encodeSyncV4OpaqueEntityIdInput('codex.item', 'provider-1'))
      .toBe('["happy-sync-v4-entity-id","codex.item","provider-1"]');
  });
});
