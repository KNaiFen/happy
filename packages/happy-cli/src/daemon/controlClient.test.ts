import { describe, expect, it } from 'vitest';
import { daemonStateMatchesCurrentProfile } from './controlClient';

const state = {
  pid: 123,
  httpPort: 456,
  startTime: 'now',
  startedWithCliVersion: '1.4.6',
  serverOrigin: 'http://relay-a.example.test:3005',
  machineRegistrationStatus: 'pending' as const,
};

describe('daemonStateMatchesCurrentProfile', () => {
  it('requires both the bundled CLI version and normalized relay origin', () => {
    expect(daemonStateMatchesCurrentProfile(
      state,
      '1.4.6',
      'http://relay-a.example.test:3005',
    )).toBe(true);
    expect(daemonStateMatchesCurrentProfile(
      state,
      '1.4.6',
      'http://relay-b.example.test:3005',
    )).toBe(false);
    expect(daemonStateMatchesCurrentProfile(
      state,
      '1.4.7',
      'http://relay-a.example.test:3005',
    )).toBe(false);
  });

  it('treats legacy state without a relay origin as incompatible', () => {
    expect(daemonStateMatchesCurrentProfile(
      { ...state, serverOrigin: undefined },
      '1.4.6',
      'http://relay-a.example.test:3005',
    )).toBe(false);
  });
});
