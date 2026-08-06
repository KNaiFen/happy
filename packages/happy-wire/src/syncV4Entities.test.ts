import { describe, expect, it } from 'vitest';
import {
  CodexCommandEntityV4Schema,
  CodexCommandResultEntityV4Schema,
  CodexEntityV4Schema,
  CodexPartEntityV4Schema,
  CodexRuntimeEntityV4Schema,
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

const item = {
  schemaVersion: 1,
  entityType: 'codex.item' as const,
  providerId: 'thread-1\0turn-1\0item-1',
  createdAt: 10,
  updatedAt: 11,
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  itemType: 'userMessage',
  status: 'completed',
  parentItemId: null,
  clientId: 'command-1',
  phase: null,
  startedAt: 10,
  completedAt: 11,
  command: null,
  cwd: null,
  processId: null,
  exitCode: null,
  durationMs: null,
  server: null,
  tool: null,
  arguments: null,
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

  it('accepts stable item event order while remaining compatible with older entities', () => {
    expect(CodexEntityV4Schema.parse({ ...item, eventSequence: 7 }))
      .toMatchObject({ eventSequence: 7 });
    expect(CodexEntityV4Schema.parse(item)).toEqual(item);
  });

  it('keeps gateway additions backward-readable while validating new generations', () => {
    const legacyRuntime = {
      schemaVersion: 1,
      entityType: 'codex.runtime' as const,
      providerId: 'thread-1\0runtime',
      createdAt: 10,
      updatedAt: 11,
      threadId: 'thread-1',
      connection: 'connected' as const,
      execution: { type: 'idle' as const },
      statusUnknown: false,
      protocolVersion: 'stable-v2',
      codexCliVersion: '0.145.0',
      syncState: 'ready' as const,
      pendingApprovalCount: 0,
      pendingUserInputCount: 0,
      activeSubagentCount: 0,
      lastError: null,
      lastKnownAt: 11,
    };
    expect(CodexRuntimeEntityV4Schema.parse(legacyRuntime)).toEqual(legacyRuntime);
    expect(CodexRuntimeEntityV4Schema.parse({
      ...legacyRuntime,
      gateway: {
        gatewayId: 'gateway-1',
        generation: 3,
        origin: 'terminal',
        role: 'current',
        state: 'running',
      },
      terminal: { state: 'detached', detachedAt: 12 },
    })).toMatchObject({
      gateway: { gatewayId: 'gateway-1', generation: 3 },
      terminal: { state: 'detached', detachedAt: 12 },
    });
  });

  it('accepts durable queue metadata, command generations, and structured cancellation results', () => {
    const command = {
      schemaVersion: 1,
      entityType: 'codex.command' as const,
      providerId: 'command-1',
      createdAt: 10,
      updatedAt: 10,
      commandId: 'command-1',
      threadId: 'thread-1',
      expectedTurnId: null,
      command: 'turn.start',
      payload: { text: 'hello' },
      clientUserMessageId: 'command-1',
      replacesCommandId: null,
    };
    expect(CodexCommandEntityV4Schema.parse(command)).toEqual(command);
    expect(CodexCommandEntityV4Schema.parse({ ...command, bindingGeneration: 4 }))
      .toMatchObject({ bindingGeneration: 4 });
    expect(CodexCommandEntityV4Schema.parse({
      ...command,
      command: 'turn.queue',
      queueEntryId: 'queue-1',
      queuedAt: 9,
    })).toMatchObject({ command: 'turn.queue', queueEntryId: 'queue-1', queuedAt: 9 });
    expect(CodexCommandResultEntityV4Schema.parse({
      schemaVersion: 1,
      entityType: 'codex.commandResult',
      providerId: 'command-1\0result',
      createdAt: 10,
      updatedAt: 11,
      commandId: 'command-1',
      threadId: 'thread-1',
      turnId: null,
      status: 'cancelled',
      providerRequestId: null,
      result: null,
      error: 'The thread binding changed before submission',
      reason: 'bindingSuperseded',
    })).toMatchObject({ status: 'cancelled', reason: 'bindingSuperseded' });
    expect(CodexCommandResultEntityV4Schema.parse({
      schemaVersion: 1,
      entityType: 'codex.commandResult',
      providerId: 'command-1\0replacement',
      createdAt: 10,
      updatedAt: 12,
      commandId: 'command-1',
      threadId: 'thread-1',
      turnId: null,
      status: 'cancelled',
      providerRequestId: null,
      result: null,
      error: 'Queued message replaced',
      reason: 'commandReplaced',
    })).toMatchObject({ status: 'cancelled', reason: 'commandReplaced' });
    expect(CodexCommandResultEntityV4Schema.parse({
      schemaVersion: 1,
      entityType: 'codex.commandResult',
      providerId: 'command-1\0cancelled',
      createdAt: 10,
      updatedAt: 13,
      commandId: 'command-1',
      threadId: 'thread-1',
      turnId: null,
      status: 'cancelled',
      providerRequestId: null,
      result: null,
      error: 'Queued message cancelled',
      reason: 'queueCancelled',
    })).toMatchObject({ status: 'cancelled', reason: 'queueCancelled' });
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
