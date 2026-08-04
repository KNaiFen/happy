import { describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/api/encryption';
import type { MachineSessionSnapshot } from '@/api/types';
import { resolveResumeSessionMaterial } from './resumeSessionMaterial';

function snapshot(overrides: Partial<MachineSessionSnapshot> = {}): MachineSessionSnapshot {
  return {
    id: 'session-1',
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

describe('resolveResumeSessionMaterial', () => {
  it('requests material without consulting Relay when the daemon has no key', async () => {
    const loadSnapshot = vi.fn();

    await expect(resolveResumeSessionMaterial({
      sessionId: 'session-1',
      machineId: 'machine-1',
      loadSnapshot,
    })).resolves.toEqual({ type: 'resumeMaterialRequired', sessionId: 'session-1' });
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('loads and verifies the original session snapshot with a 32-byte independent key', async () => {
    const loadSnapshot = vi.fn().mockResolvedValue(snapshot());

    await expect(resolveResumeSessionMaterial({
      sessionId: 'session-1',
      machineId: 'machine-1',
      dataEncryptionKey: encodeBase64(new Uint8Array(32).fill(7)),
      loadSnapshot,
    })).resolves.toEqual({ type: 'snapshot', snapshot: snapshot() });
    expect(loadSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      machineId: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'dataKey',
    }));
  });

  it('rejects invalid keys and snapshots from another machine', async () => {
    const loadSnapshot = vi.fn().mockResolvedValue(snapshot({ originMachineId: 'machine-2' }));

    await expect(resolveResumeSessionMaterial({
      sessionId: 'session-1',
      machineId: 'machine-1',
      dataEncryptionKey: encodeBase64(new Uint8Array(31).fill(7)),
      loadSnapshot,
    })).resolves.toMatchObject({ type: 'error' });
    expect(loadSnapshot).not.toHaveBeenCalled();

    await expect(resolveResumeSessionMaterial({
      sessionId: 'session-1',
      machineId: 'machine-1',
      dataEncryptionKey: encodeBase64(new Uint8Array(32).fill(7)),
      loadSnapshot,
    })).resolves.toEqual({
      type: 'error',
      errorMessage: 'The Happy session does not belong to this active machine.',
    });
  });
});
