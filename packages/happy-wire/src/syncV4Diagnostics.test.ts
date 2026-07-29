import { describe, expect, it } from 'vitest';
import {
  classifySyncV4DiagnosticError,
  createSyncV4DiagnosticRecord,
  MAX_SYNC_V4_DIAGNOSTIC_RECORD_BYTES,
  requireSyncV4TraceEcho,
  SyncV4DiagnosticRecordSchema,
} from './syncV4Diagnostics';

describe('Sync v4 diagnostics', () => {
  it('accepts only payload-free allowlisted fields', () => {
    const record = createSyncV4DiagnosticRecord({
      level: 'info',
      component: 'cli.sync',
      event: 'transport',
      phase: 'completed',
      traceId: 'a'.repeat(32),
      sessionHash: 'opaque_session_123',
      featureEnabled: true,
      transportSecurity: 'insecureHttp',
      transportOperation: 'changes',
      cursor: 10,
      highWatermark: 12,
      count: 2,
      durationMs: 25,
      suppressed: 4,
      invalid: 1,
      writeFailures: 2,
      listenerFailures: 3,
    }, () => 123);

    expect(record).toEqual({
      schemaVersion: 1,
      timestamp: 123,
      level: 'info',
      component: 'cli.sync',
      event: 'transport',
      phase: 'completed',
      traceId: 'a'.repeat(32),
      sessionHash: 'opaque_session_123',
      featureEnabled: true,
      transportSecurity: 'insecureHttp',
      transportOperation: 'changes',
      cursor: 10,
      highWatermark: 12,
      count: 2,
      durationMs: 25,
      suppressed: 4,
      invalid: 1,
      writeFailures: 2,
      listenerFailures: 3,
    });
    expect(new TextEncoder().encode(JSON.stringify(record)).byteLength)
      .toBeLessThanOrEqual(MAX_SYNC_V4_DIAGNOSTIC_RECORD_BYTES);
  });

  it('rejects plaintext and arbitrary payload fields', () => {
    const secret = 'prompt-secret-that-must-never-be-logged';
    expect(() => SyncV4DiagnosticRecordSchema.parse({
      schemaVersion: 1,
      timestamp: 1,
      level: 'error',
      component: 'cli.gateway',
      event: 'rpc',
      phase: 'failed',
      message: secret,
      payload: { prompt: secret },
    })).toThrow();
  });

  it('classifies external errors without serializing their contents', () => {
    const secret = 'raw-provider-error-secret';
    const error = {
      name: 'AxiosError',
      code: 'ECONNABORTED',
      message: secret,
      response: {
        data: { prompt: secret, reasoning: secret, toolOutput: secret },
      },
    };

    const record = createSyncV4DiagnosticRecord({
      level: 'warn',
      component: 'app.sync',
      event: 'transport',
      phase: 'failed',
      errorKind: classifySyncV4DiagnosticError(error),
    }, () => 1);

    expect(record.errorKind).toBe('timeout');
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it.each([
    [{ response: { status: 401 } }, 'authentication'],
    [{ statusCode: 400 }, 'validation'],
    [{ statusCode: 413 }, 'validation'],
    [{ statusCode: 401 }, 'authentication'],
    [{ statusCode: 403 }, 'authorization'],
    [{ statusCode: 426 }, 'protocol'],
    [{ statusCode: 429 }, 'rateLimited'],
    [{ statusCode: 502 }, 'server'],
    [{ response: { status: 403 } }, 'authorization'],
    [{ response: { status: 404 } }, 'notFound'],
    [{ response: { status: 409 } }, 'conflict'],
    [{ response: { status: 429 } }, 'rateLimited'],
    [{ response: { status: 503 } }, 'server'],
    [{ name: 'AbortError' }, 'cancelled'],
    [{ code: 'ENOTFOUND' }, 'network'],
    [{ name: 'ZodError' }, 'validation'],
    [{ name: 'SyncV4RevisionConflictError' }, 'conflict'],
    [{ name: 'SyncV4DecryptionError' }, 'crypto'],
    [{ name: 'SyncV4JournalPoisonedError' }, 'storage'],
    [{ name: 'SyncV4ProjectionError' }, 'projection'],
    [{ name: 'CodexRpcOutcomeUnknownError' }, 'protocol'],
    [{ message: 'unclassified secret' }, 'unknown'],
  ] as const)('classifies %# as %s', (error, expected) => {
    expect(classifySyncV4DiagnosticError(error)).toBe(expected);
  });

  it('fails open when an external error exposes throwing getters or proxy traps', () => {
    const throwingGetter = Object.defineProperty({}, 'response', {
      get: () => {
        throw new Error('prompt-secret-from-getter');
      },
    });
    const throwingProxy = new Proxy({}, {
      get: () => {
        throw new Error('reasoning-secret-from-proxy');
      },
    });

    expect(() => classifySyncV4DiagnosticError(throwingGetter)).not.toThrow();
    expect(() => classifySyncV4DiagnosticError(throwingProxy)).not.toThrow();
    expect(classifySyncV4DiagnosticError(throwingGetter)).toBe('unknown');
    expect(classifySyncV4DiagnosticError(throwingProxy)).toBe('unknown');
  });

  it('requires an exact server trace echo without retaining the supplied value', () => {
    const expected = 'a'.repeat(32);

    expect(() => requireSyncV4TraceEcho(expected, expected)).not.toThrow();
    expect(() => requireSyncV4TraceEcho(undefined, undefined)).not.toThrow();
    expect(() => requireSyncV4TraceEcho(expected, 'b'.repeat(32))).toThrow(
      'trace echo did not match',
    );
    try {
      requireSyncV4TraceEcho(expected, 'prompt-reasoning-secret');
    } catch (error) {
      expect(String(error)).not.toContain('prompt-reasoning-secret');
      expect(classifySyncV4DiagnosticError(error)).toBe('protocol');
    }
  });
});
