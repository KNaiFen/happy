import { existsSync } from 'node:fs';

import type { Metadata } from '@/api/types';
import { encodeBase64 } from '@/api/encryption';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { buildSessionChildEnvironment, sanitizeSessionEnvironment } from '@/daemon/sessionEnvironment';

import { LocalResumeSessionError, resolveLocalReconnectableSession } from './localResumeStore';
import { type ReconnectableHappySession, type ResumableHappySession } from './resolveHappySession';

export type ResumeLaunch = {
    cwd: string;
    args: string[];
};

export type ResumeLaunchOptions = {
    startedBy?: 'daemon' | 'terminal';
    model?: string;
    permissionMode?: string;
    effort?: string;
};

export function parseResumeCommandArgs(args: string[]): { showHelp: boolean; sessionId: string } {
    if (args.includes('-h') || args.includes('--help')) {
        return {
            showHelp: true,
            sessionId: '',
        };
    }

    if (args.length === 0) {
        throw new Error('Happy session ID is required: happy resume <session-id>');
    }
    if (args.length > 1) {
        throw new Error(`Unexpected arguments for happy resume: ${args.slice(1).join(' ')}`);
    }

    return {
        showHelp: false,
        sessionId: args[0],
    };
}

function resolveFlavor(metadata: Metadata): 'codex' | null {
    if (metadata.flavor === 'codex' && metadata.codexSyncVersion === 4) {
        return 'codex';
    }
    return null;
}

export function buildResumeLaunch(session: ResumableHappySession, options: ResumeLaunchOptions = {}): ResumeLaunch {
    const { metadata } = session;
    const flavor = resolveFlavor(metadata);

    if (flavor === 'codex') {
        if (!metadata.codexThreadId) {
            throw new Error(`Happy session ${session.id} is missing its Codex thread ID.`);
        }
        const args = ['codex', '--resume', metadata.codexThreadId];
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        const permissionMode = options.permissionMode ?? metadata.permissionMode ?? undefined;
        const model = options.model ?? metadata.modelMode ?? undefined;
        const effort = options.effort ?? metadata.effortLevel ?? undefined;
        if (permissionMode) args.push('--permission-mode', permissionMode);
        if (model && model !== 'default') args.push('--model', model);
        if (effort) args.push('--effort', effort);
        return {
            cwd: metadata.path,
            args,
        };
    }

    throw new Error(`Happy session ${session.id} uses unsupported flavor "${metadata.flavor ?? 'unknown'}".`);
}

export function formatResumeHelp(): string {
    return [
        'happy resume - Resume a previous Happy session',
        '',
        'Usage:',
        '  happy resume <happy-session-id>',
        '',
        'Examples:',
        '  happy resume cmmij8olq00dp5jcxr3wtbpau',
        '  happy resume cmmij8',
        '',
        'This reuses the saved worktree/path and resumes the underlying agent session',
        'when the backend supports it.',
    ].join('\n');
}

function buildReconnectEnv(session: ReconnectableHappySession): NodeJS.ProcessEnv {
    return buildSessionChildEnvironment(process.env, {
        HAPPY_RECONNECT_SESSION_ID: session.id,
        HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(session.encryptionKey),
        HAPPY_RECONNECT_ENCRYPTION_VARIANT: session.encryptionVariant,
        HAPPY_RECONNECT_SEQ: String(session.seq),
        HAPPY_RECONNECT_METADATA_VERSION: String(session.metadataVersion),
        HAPPY_RECONNECT_AGENT_STATE_VERSION: String(session.agentStateVersion),
    });
}

function spawnResumeChild(launch: ResumeLaunch, env: NodeJS.ProcessEnv = sanitizeSessionEnvironment(process.env)): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawnHappyCLI(launch.args, {
            cwd: launch.cwd,
            env,
            stdio: 'inherit',
        });

        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`Resumed session exited via signal ${signal}`));
                return;
            }
            resolve(code);
        });
    });
}

export async function handleResumeCommand(args: string[]): Promise<void> {
    const parsed = parseResumeCommandArgs(args);
    if (parsed.showHelp) {
        console.log(formatResumeHelp());
        return;
    }

    let reconnectableSession: ReconnectableHappySession;
    try {
        reconnectableSession = await resolveLocalReconnectableSession(parsed.sessionId);
    } catch (error) {
        if (error instanceof LocalResumeSessionError && error.code === 'ambiguous') {
            throw error;
        }
        throw error;
    }

    const launch = buildResumeLaunch(reconnectableSession);

    if (!existsSync(launch.cwd)) {
        throw new Error(`Saved session path does not exist: ${launch.cwd}`);
    }

    const exitCode = await spawnResumeChild(launch, buildReconnectEnv(reconnectableSession));
    if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exit(exitCode);
    }
}
