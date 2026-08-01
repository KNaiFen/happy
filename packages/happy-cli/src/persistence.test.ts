import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    acquireDaemonLock,
    persistSession,
    readPersistedSessions,
    readCredentials,
    releaseDaemonLock,
    SandboxConfigSchema,
    writeCredentialsLegacy,
} from './persistence';

const mockConfiguration = vi.hoisted(() => ({
    daemonLockFile: '',
    daemonStateFile: '',
    isDaemonProcess: false,
    logsDir: '/tmp',
    sessionsFile: '',
    happyHomeDir: '',
    privateKeyFile: '',
    serverUrl: 'http://relay.example.test:3005',
}));

vi.mock('@/configuration', () => ({
    configuration: mockConfiguration,
}));

describe('SandboxConfigSchema', () => {
    it('applies defaults when values are omitted', () => {
        const parsed = SandboxConfigSchema.parse({});

        expect(parsed).toEqual({
            enabled: false,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg'],
            extraWritePaths: ['/tmp'],
            denyWritePaths: ['.env'],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        });
    });

    it('accepts a fully custom valid sandbox config', () => {
        const parsed = SandboxConfigSchema.parse({
            enabled: true,
            workspaceRoot: '~/projects',
            sessionIsolation: 'custom',
            customWritePaths: ['~/projects/foo', '/var/tmp'],
            denyReadPaths: ['~/.ssh'],
            extraWritePaths: ['/tmp', '/private/tmp'],
            denyWritePaths: ['.env', '.secrets'],
            networkMode: 'custom',
            allowedDomains: ['api.openai.com', '*.github.com'],
            deniedDomains: ['tracking.example.com'],
            allowLocalBinding: false,
        });

        expect(parsed.enabled).toBe(true);
        expect(parsed.workspaceRoot).toBe('~/projects');
        expect(parsed.sessionIsolation).toBe('custom');
        expect(parsed.networkMode).toBe('custom');
        expect(parsed.allowedDomains).toEqual(['api.openai.com', '*.github.com']);
        expect(parsed.allowLocalBinding).toBe(false);
    });

    it('rejects invalid enum values', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                sessionIsolation: 'invalid',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                networkMode: 'invalid',
            }),
        ).toThrow();
    });

    it('rejects invalid field types', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                allowLocalBinding: 'yes',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                denyReadPaths: [123],
            }),
        ).toThrow();
    });
});

describe('acquireDaemonLock', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'happy-daemon-lock-'));
        mockConfiguration.daemonLockFile = join(testDir, 'daemon.state.json.lock');
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it.each([
        ['empty', ''],
        ['non-numeric', 'not-a-pid'],
        ['zero-pid', '0'],
    ])('treats a %s lock file as stale and acquires a fresh lock', async (_label, lockContent) => {
        writeFileSync(mockConfiguration.daemonLockFile, lockContent, 'utf-8');

        // Lock creation is atomic including the PID payload (temp file +
        // hard link), so a payload-less lock can never belong to a live
        // acquirer and is reclaimed on first sight.
        const lockHandle = await acquireDaemonLock(2, 0);

        expect(lockHandle).not.toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
        await releaseDaemonLock(lockHandle!);
        expect(existsSync(mockConfiguration.daemonLockFile)).toBe(false);
    });

    it('creates the lock with its PID payload atomically (no temp file left behind)', async () => {
        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).not.toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
        expect(existsSync(`${mockConfiguration.daemonLockFile}.${process.pid}.tmp`)).toBe(false);
        await releaseDaemonLock(lockHandle!);
    });

    it('does not clear a lock held by a live process', async () => {
        writeFileSync(mockConfiguration.daemonLockFile, String(process.pid), 'utf-8');

        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
    });
});

describe('persisted resume sessions', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'happy-sessions-'));
        mockConfiguration.sessionsFile = join(testDir, 'sessions.json');
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it('retains old resume material and stores the journal with mode 0600', () => {
        persistSession('session-old', {
            encryptionKey: Buffer.alloc(32, 7).toString('base64'),
            encryptionVariant: 'dataKey',
            seq: 42,
            metadataVersion: 3,
            agentStateVersion: 4,
            metadata: {
                path: '/tmp/repo',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'codex',
                codexThreadId: 'thread-1',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
            hostPid: 12345,
            savedAt: Date.now() - (90 * 24 * 60 * 60 * 1_000),
        });

        expect(readPersistedSessions()).toMatchObject({
            'session-old': { hostPid: 12345 },
        });
        expect(statSync(mockConfiguration.sessionsFile).mode & 0o777).toBe(0o600);
        expect(existsSync(`${mockConfiguration.sessionsFile}.tmp`)).toBe(false);
    });
});

describe('credential relay origin', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'happy-credentials-'));
        mockConfiguration.happyHomeDir = testDir;
        mockConfiguration.privateKeyFile = join(testDir, 'access.key');
        mockConfiguration.serverUrl = 'http://relay.example.test:3005';
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it('atomically persists the normalized relay origin with mode 0600', async () => {
        await writeCredentialsLegacy({
            secret: new Uint8Array(32).fill(7),
            token: 'test-token',
        });

        const raw = JSON.parse(readFileSync(mockConfiguration.privateKeyFile, 'utf8'));
        expect(raw.serverOrigin).toBe('http://relay.example.test:3005');
        expect(statSync(mockConfiguration.privateKeyFile).mode & 0o777).toBe(0o600);
        await expect(readCredentials()).resolves.toEqual(expect.objectContaining({
            token: 'test-token',
            serverOrigin: 'http://relay.example.test:3005',
        }));
    });

    it('keeps legacy credentials without an origin readable for one-time validation', async () => {
        writeFileSync(mockConfiguration.privateKeyFile, JSON.stringify({
            secret: Buffer.alloc(32, 3).toString('base64'),
            token: 'legacy-token',
        }));

        await expect(readCredentials()).resolves.toEqual(expect.objectContaining({
            token: 'legacy-token',
        }));
        expect((await readCredentials())?.serverOrigin).toBeUndefined();
    });
});
