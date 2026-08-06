import { describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/api/encryption';
import type { MachineSessionSnapshot } from '@/api/types';
import {
  CodexThreadBindingError,
  CodexThreadUnavailableError,
  type CodexThreadHistorySummary,
} from '@/codex/codexThreadHistory';
import {
  preflightResumeSessions,
  type PreflightResumeSessionsDependencies,
} from './preflightResumeSessions';
import type { CodexGatewaySessionInspection } from '@/codex/gateway/codexGatewayLauncher';

const dataEncryptionKey = encodeBase64(new Uint8Array(32).fill(7));

function snapshot(
  sessionId: string,
  overrides: Partial<MachineSessionSnapshot> = {},
): MachineSessionSnapshot {
  return {
    id: sessionId,
    seq: 1,
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: 'dataKey',
    metadata: {
      path: '/tmp/project',
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happy',
      happyLibDir: '/tmp/happy',
      happyToolsDir: '/tmp/happy/tools',
      machineId: 'machine-1',
      flavor: 'codex',
      codexSyncVersion: 4,
      codexThreadId: 'thread-1',
    },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    active: false,
    archivedAt: null,
    originMachineId: 'machine-1',
    machineDeletedAt: null,
    hasIndependentDataKey: true,
    ...overrides,
  };
}

function thread(
  overrides: Partial<CodexThreadHistorySummary> = {},
): CodexThreadHistorySummary {
  return {
    threadId: 'thread-1',
    title: 'Thread',
    preview: 'Thread preview',
    cwd: '/tmp/project',
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    source: 'cli',
    status: 'idle',
    ...overrides,
  };
}

function request(sessionIds: string[]) {
  return {
    sessions: sessionIds.map((sessionId) => ({
      sessionId,
      directory: '/tmp/project',
      threadId: 'thread-1',
      dataEncryptionKey,
    })),
  };
}

function dependencies(
  overrides: Partial<PreflightResumeSessionsDependencies> = {},
): PreflightResumeSessionsDependencies {
  return {
    machineId: 'machine-1',
    loadSnapshot: vi.fn(async ({ sessionId }) => snapshot(sessionId)),
    inspectThread: vi.fn(async () => thread()),
    inspectGateway: vi.fn(async (): Promise<CodexGatewaySessionInspection> => ({
      state: 'missing',
      gateway: null,
    })),
    ...overrides,
  };
}

describe('preflightResumeSessions', () => {
  it('returns eligible without mutating or opening the session', async () => {
    const deps = dependencies();

    await expect(preflightResumeSessions(request(['session-1']), deps)).resolves.toEqual({
      type: 'success',
      results: [{ type: 'eligible', sessionId: 'session-1' }],
    });
    expect(deps.loadSnapshot).toHaveBeenCalledOnce();
    expect(deps.inspectThread).toHaveBeenCalledWith('/tmp/project', 'thread-1');
    expect(deps.inspectGateway).toHaveBeenCalledWith({
      sessionId: 'session-1',
      threadId: 'thread-1',
    });
  });

  it.each([
    ['live', 'idle', { type: 'alreadyActive', sessionId: 'session-1' }],
    ['recovering', 'idle', {
      type: 'pending',
      sessionId: 'session-1',
      reason: 'gatewayRecovering',
    }],
    ['missing', 'active', {
      type: 'pending',
      sessionId: 'session-1',
      reason: 'externalThreadActive',
    }],
  ] as const)(
    'classifies gateway %s with provider status %s',
    async (gatewayState, providerStatus, expected) => {
      const deps = dependencies({
        inspectThread: vi.fn(async () => thread({ status: providerStatus })),
        inspectGateway: vi.fn(async (): Promise<CodexGatewaySessionInspection> => ({
          state: gatewayState,
          gateway: null,
        })),
      });

      const result = await preflightResumeSessions(request(['session-1']), deps);

      expect(result.results).toEqual([expected]);
    },
  );

  it('classifies missing threads and invalid bindings as terminal', async () => {
    const unavailable = dependencies({
      inspectThread: vi.fn(async () => {
        throw new CodexThreadUnavailableError();
      }),
    });
    const invalid = dependencies({
      inspectThread: vi.fn(async () => {
        throw new CodexThreadBindingError();
      }),
    });

    await expect(preflightResumeSessions(request(['session-1']), unavailable))
      .resolves.toMatchObject({
        results: [{ type: 'ineligible', reason: 'threadUnavailable' }],
      });
    await expect(preflightResumeSessions(request(['session-1']), invalid))
      .resolves.toMatchObject({
        results: [{ type: 'ineligible', reason: 'invalidBinding' }],
      });
  });

  it('isolates transient provider failures and preserves input order', async () => {
    const deps = dependencies({
      inspectThread: vi.fn(async (_directory, threadId) => {
        if (threadId === 'thread-failed') throw new Error('provider unavailable');
        return thread({ threadId });
      }),
      loadSnapshot: vi.fn(async ({ sessionId }) => snapshot(sessionId, {
        metadata: {
          ...snapshot(sessionId).metadata,
          codexThreadId: sessionId === 'session-2' ? 'thread-failed' : 'thread-1',
        },
      })),
    });
    const batch = request(['session-1', 'session-2', 'session-3']);
    batch.sessions[1] = {
      ...batch.sessions[1],
      threadId: 'thread-failed',
    };

    const result = await preflightResumeSessions(batch, deps);

    expect(result.results).toEqual([
      { type: 'eligible', sessionId: 'session-1' },
      { type: 'pending', sessionId: 'session-2', reason: 'providerUnavailable' },
      { type: 'eligible', sessionId: 'session-3' },
    ]);
  });

  it('rejects unsupported v4 bindings before gateway inspection', async () => {
    const inspectGateway = vi.fn();
    const deps = dependencies({
      loadSnapshot: vi.fn(async ({ sessionId }) => snapshot(sessionId, {
        metadata: {
          ...snapshot(sessionId).metadata,
          codexSyncVersion: undefined,
        },
      })),
      inspectGateway,
    });

    await expect(preflightResumeSessions(request(['session-1']), deps)).resolves.toMatchObject({
      results: [{ type: 'ineligible', reason: 'invalidBinding' }],
    });
    expect(inspectGateway).not.toHaveBeenCalled();
  });

  it('keeps transient Relay lookup failures pending without consulting the provider', async () => {
    const inspectThread = vi.fn();
    const deps = dependencies({
      loadSnapshot: vi.fn().mockRejectedValue(new Error('relay unavailable')),
      inspectThread,
    });

    await expect(preflightResumeSessions(request(['session-1']), deps)).resolves.toEqual({
      type: 'success',
      results: [{
        type: 'pending',
        sessionId: 'session-1',
        reason: 'relayUnavailable',
      }],
    });
    expect(inspectThread).not.toHaveBeenCalled();
  });
});
