#!/usr/bin/env node

import { Command } from 'commander';
import { join } from 'node:path';
import { loadConfig } from './config';
import type { Config } from './config';
import { requireCredentials } from './credentials';
import type { Credentials } from './credentials';
import { authLogin, authLogout, authStatus } from './auth';
import { listSessions, listActiveSessions, listMachines } from './api';
import type { DecryptedMachine, DecryptedSession } from './api';
import { resumeSessionOnMachine, spawnSessionOnMachine } from './machineRpc';
import { SessionClient, codexHistoryFromSnapshot } from './session';
import { formatMachineTable, formatSessionTable, formatSessionStatus, formatMessageHistory, formatJson } from './output';
import { filterSupportedAgentSessions } from './sessionClassification';
import { HAPPY_AGENT_VERSION } from './clientVersion';

// --- Helpers ---

function resolveByPrefix<T extends { id: string }>(items: T[], value: string, label: string): T {
    if (!value || value.trim().length === 0) {
        throw new Error(`${label} is required`);
    }
    const matches = items.filter(item => item.id.startsWith(value));
    if (matches.length === 0) {
        throw new Error(`No ${label.toLowerCase()} found matching "${value}"`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous ${label.toLowerCase()} "${value}" matches ${matches.length} records. Be more specific.`);
    }
    return matches[0];
}

async function resolveSession(config: Config, creds: Credentials, sessionId: string): Promise<DecryptedSession> {
    const sessions = filterSupportedAgentSessions(await listSessions(config, creds));
    return resolveByPrefix(sessions, sessionId, 'Session ID');
}

async function resolveMachine(config: Config, creds: Credentials, machineId: string): Promise<DecryptedMachine> {
    const machines = await listMachines(config, creds);
    return resolveByPrefix(machines, machineId, 'Machine ID');
}

function createClient(session: DecryptedSession, creds: Credentials, config: Config): SessionClient {
    const metadata = session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? session.metadata as Record<string, unknown>
        : {};
    return new SessionClient({
        sessionId: session.id,
        encryptionKey: session.encryption.key,
        token: creds.token,
        serverUrl: config.serverUrl,
        threadId: typeof metadata.codexThreadId === 'string' ? metadata.codexThreadId : null,
        machineId: typeof metadata.machineId === 'string' ? metadata.machineId : null,
    });
}

function resolveRemotePath(rawPath: string | undefined, machine: DecryptedMachine): string {
    const metadata = (machine.metadata ?? {}) as { homeDir?: unknown };
    const homeDir = typeof metadata.homeDir === 'string' && metadata.homeDir.trim().length > 0
        ? metadata.homeDir
        : undefined;
    const path = rawPath ?? homeDir;

    if (!path) {
        throw new Error('Machine metadata does not include a home directory. Pass --path explicitly.');
    }

    if (path === '~') {
        if (!homeDir) {
            throw new Error('Machine metadata does not include a home directory, so `~` cannot be resolved. Pass an absolute --path.');
        }
        return homeDir;
    }
    if (path.startsWith('~/')) {
        if (!homeDir) {
            throw new Error('Machine metadata does not include a home directory, so `~/...` cannot be resolved. Pass an absolute --path.');
        }
        const normalizedHome = homeDir.endsWith('/') || homeDir.endsWith('\\')
            ? homeDir.slice(0, -1)
            : homeDir;
        const separator = normalizedHome.includes('\\') && !normalizedHome.includes('/')
            ? '\\'
            : '/';
        return join(normalizedHome, path.slice(2)).replaceAll('/', separator);
    }
    return path;
}

function resolveSessionMachineId(session: DecryptedSession): string {
    const metadata = (session.metadata ?? {}) as { machineId?: unknown };
    if (typeof metadata.machineId !== 'string' || metadata.machineId.trim().length === 0) {
        throw new Error(`Session ${session.id} is missing machine metadata and cannot be resumed.`);
    }
    return metadata.machineId;
}

function ensureMachineCanResume(machine: DecryptedMachine): void {
    const metadata = (machine.metadata ?? {}) as {
        resumeSupport?: {
            rpcAvailable?: unknown;
        };
    };

    if (metadata.resumeSupport?.rpcAvailable === true) {
        return;
    }

    throw new Error('Resume RPC is unavailable on this machine right now.');
}

// --- CLI ---

const program = new Command();

program
    .name('happy-agent')
    .description('CLI client for controlling Codex sessions remotely')
    .version(HAPPY_AGENT_VERSION);

program
    .command('auth')
    .description('Manage authentication')
    .addCommand(
        new Command('login').description('Authenticate via QR code').action(async () => {
            const config = loadConfig();
            await authLogin(config);
        })
    )
    .addCommand(
        new Command('logout').description('Clear stored credentials').action(async () => {
            const config = loadConfig();
            await authLogout(config);
        })
    )
    .addCommand(
        new Command('status').description('Show authentication status').action(async () => {
            const config = loadConfig();
            await authStatus(config);
        })
    );

program
    .command('machines')
    .description('List all machines')
    .option('--active', 'Show only active machines')
    .option('--json', 'Output as JSON')
    .action(async (opts: { active?: boolean; json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const machines = await listMachines(config, creds);
        const filtered = opts.active ? machines.filter(machine => machine.active) : machines;
        if (opts.json) {
            console.log(formatJson(filtered));
        } else {
            console.log(formatMachineTable(filtered));
        }
    });

program
    .command('list')
    .description('List all sessions')
    .option('--active', 'Show only active sessions')
    .option('--json', 'Output as JSON')
    .action(async (opts: { active?: boolean; json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const sessions = filterSupportedAgentSessions(opts.active
            ? await listActiveSessions(config, creds)
            : await listSessions(config, creds));
        if (opts.json) {
            console.log(formatJson(sessions));
        } else {
            console.log(formatSessionTable(sessions));
        }
    });

program
    .command('status')
    .description('Get authoritative Codex Sync v4 session state')
    .argument('<session-id>', 'Session ID or prefix')
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, opts: { json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);

        const snapshot = await createClient(session, creds, config).readSnapshot();

        if (opts.json) {
            console.log(formatJson({ session, codex: snapshot }));
        } else {
            console.log(formatSessionStatus(session, snapshot));
        }
    });

program
    .command('spawn')
    .description('Spawn a new Codex session on a machine')
    .requiredOption('--machine <machine-id>', 'Machine ID or prefix')
    .option('--path <path>', 'Working directory path (defaults to machine home directory)')
    .option('--create-dir', 'Allow creating the directory if it does not exist')
    .option('--json', 'Output as JSON')
    .action(async (opts: {
        machine: string;
        path?: string;
        createDir?: boolean;
        json?: boolean;
    }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const machine = await resolveMachine(config, creds, opts.machine);
        const directory = resolveRemotePath(opts.path, machine);

        const result = await spawnSessionOnMachine(config, machine, creds.token, {
            directory,
            approvedNewDirectoryCreation: opts.createDir,
            agent: 'codex',
        });

        const payload = {
            machineId: machine.id,
            directory,
            agent: 'codex',
            ...result,
        };

        if (opts.json) {
            console.log(formatJson(payload));
            if (result.type !== 'success') {
                process.exitCode = 1;
            }
            return;
        }

        switch (result.type) {
            case 'success':
                console.log([
                    '## Session Spawned',
                    '',
                    `- Machine ID: \`${machine.id}\``,
                    `- Session ID: \`${result.sessionId}\``,
                    `- Path: ${directory}`,
                    '- Agent: codex',
                ].join('\n'));
                break;
            case 'requestToApproveDirectoryCreation':
                throw new Error(`The directory '${result.directory}' does not exist. Re-run with --create-dir to allow creating it.`);
            case 'error':
                throw new Error(result.errorMessage);
        }
    });

program
    .command('resume')
    .description('Resume a session on its original machine')
    .argument('<session-id>', 'Session ID or prefix')
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, opts: { json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);
        const machineId = resolveSessionMachineId(session);
        const machine = await resolveMachine(config, creds, machineId);
        ensureMachineCanResume(machine);

        const result = await resumeSessionOnMachine(config, machine, creds.token, session.id);
        const payload = {
            sourceSessionId: session.id,
            machineId: machine.id,
            ...result,
        };

        if (opts.json) {
            console.log(formatJson(payload));
            if (result.type !== 'success') {
                process.exitCode = 1;
            }
            return;
        }

        switch (result.type) {
            case 'success':
                console.log([
                    '## Session Resumed',
                    '',
                    `- Machine ID: \`${machine.id}\``,
                    `- Source Session ID: \`${session.id}\``,
                    `- Resumed Session ID: \`${result.sessionId}\``,
                ].join('\n'));
                break;
            case 'requestToApproveDirectoryCreation':
                throw new Error(`Resume unexpectedly requested directory creation for '${result.directory}'. Resume should reuse the saved path.`);
            case 'error':
                throw new Error(result.errorMessage);
        }
    });

program
    .command('send')
    .description('Send a message to a session')
    .argument('<session-id>', 'Session ID or prefix')
    .argument('<message>', 'Message text')
    .option('--yolo', 'Send with permissionMode=yolo')
    .option('--wait', 'Wait for agent to become idle')
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, message: string, opts: { yolo?: boolean; wait?: boolean; json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);
        const permissionMode = opts.yolo ? 'yolo' : null;

        const client = createClient(session, creds, config);
        const published = await client.sendMessage(
            message,
            permissionMode ? { permissionMode } : undefined,
        );
        if (opts.wait) {
            await client.waitForCommandAndIdle(published.command.commandId);
        }

        if (opts.json) {
            console.log(formatJson({ sessionId: session.id, message, sent: true, permissionMode }));
        } else {
            console.log([
                '## Message Sent',
                '',
                `- Session ID: \`${session.id}\``,
                `- Permission Mode: ${permissionMode ?? 'default'}`,
                `- Waited For Idle: ${opts.wait ? 'yes' : 'no'}`,
            ].join('\n'));
        }
    });

program
    .command('history')
    .description('Read message history')
    .argument('<session-id>', 'Session ID or prefix')
    .option('--limit <n>', 'Limit number of messages', (v: string) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n <= 0) throw new Error('--limit must be a positive integer');
        return n;
    })
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, opts: { limit?: number; json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);
        const snapshot = await createClient(session, creds, config).readSnapshot();
        let messages = codexHistoryFromSnapshot(snapshot);

        // Apply limit
        if (opts.limit && opts.limit > 0) {
            messages = messages.slice(-opts.limit);
        }

        if (opts.json) {
            console.log(formatJson(messages));
        } else {
            console.log(formatMessageHistory(messages));
        }
    });

program
    .command('stop')
    .description('Interrupt the active Codex turn')
    .argument('<session-id>', 'Session ID or prefix')
    .action(async (sessionId: string) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);

        const client = createClient(session, creds, config);
        await client.stopAndWait();

        console.log([
            '## Session Stopped',
            '',
            `- Session ID: \`${session.id}\``,
        ].join('\n'));
    });

program
    .command('wait')
    .description('Wait for agent to become idle')
    .argument('<session-id>', 'Session ID or prefix')
    .option('--timeout <seconds>', 'Timeout in seconds', (v: string) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n <= 0) throw new Error('--timeout must be a positive integer');
        return n;
    }, 300)
    .action(async (sessionId: string, opts: { timeout: number }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);

        try {
            await createClient(session, creds, config).waitForIdle(opts.timeout * 1000);
            console.log([
                '## Session Idle',
                '',
                `- Session ID: \`${session.id}\``,
            ].join('\n'));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(msg);
            process.exitCode = 1;
        }
    });

program.parseAsync(process.argv).catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
