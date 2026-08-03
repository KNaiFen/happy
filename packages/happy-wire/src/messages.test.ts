import { describe, expect, it } from 'vitest';
import {
  ApiUpdateMachineStateSchema,
  ApiUpdateSessionStateSchema,
  CoreUpdateContainerSchema,
} from './messages';

describe('shared control-plane update schemas', () => {
  it('parses an encrypted session metadata update', () => {
    expect(ApiUpdateSessionStateSchema.safeParse({
      t: 'update-session',
      id: 'session-1',
      metadata: { version: 2, value: 'abc' },
      agentState: { version: 3, value: null },
    }).success).toBe(true);
  });

  it('parses a machine state update with activity fields', () => {
    expect(ApiUpdateMachineStateSchema.safeParse({
      t: 'update-machine',
      machineId: 'machine-1',
      metadata: { version: 1, value: 'abc' },
      daemonState: { version: 2, value: 'def' },
      active: true,
      activeAt: 12345,
    }).success).toBe(true);
  });

  it('accepts only retained session and machine update variants', () => {
    const examples = [
      {
        id: 'upd-1',
        seq: 1,
        body: {
          t: 'update-session',
          id: 'session-1',
          metadata: null,
          agentState: { version: 1, value: null },
        },
        createdAt: 1,
      },
      {
        id: 'upd-2',
        seq: 2,
        body: {
          t: 'update-machine',
          machineId: 'machine-1',
          metadata: null,
          daemonState: null,
        },
        createdAt: 2,
      },
    ];

    for (const sample of examples) {
      expect(CoreUpdateContainerSchema.safeParse(sample).success).toBe(true);
    }

    expect(CoreUpdateContainerSchema.safeParse({
      id: 'upd-v3',
      seq: 3,
      body: { t: 'new-message', sid: 'session-1', message: {} },
      createdAt: 3,
    }).success).toBe(false);
  });
});
