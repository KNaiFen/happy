import { existsSync } from 'node:fs';

import { encodeBase64 } from '@/api/encryption';
import {
    createCodexGatewayResumeBootstrap,
    resumeCodexGatewayTui,
} from '@/codex/gateway/codexGatewayResume';
import type { CodexGatewayResumeBootstrap } from '@/codex/gateway/codexGatewayState';

import { resolveLocalReconnectableSession } from './localResumeStore';
import type { ReconnectableHappySession } from './resolveHappySession';

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

export function buildResumeBootstrap(
    session: ReconnectableHappySession,
): CodexGatewayResumeBootstrap {
    const { metadata } = session;
    if (metadata.flavor !== 'codex' || metadata.codexSyncVersion !== 4) {
        throw new Error(`Happy session ${session.id} uses unsupported flavor "${metadata.flavor ?? 'unknown'}".`);
    }
    if (!metadata.codexThreadId) {
        throw new Error(`Happy session ${session.id} is missing its Codex thread ID.`);
    }
    if (session.encryptionVariant !== 'dataKey') {
        throw new Error(`Happy session ${session.id} does not have an independent Sync v4 data key.`);
    }
    return createCodexGatewayResumeBootstrap({
        happySessionId: session.id,
        dataEncryptionKey: encodeBase64(session.encryptionKey),
        threadId: metadata.codexThreadId,
        cwd: metadata.path,
        model: metadata.modelMode && metadata.modelMode !== 'default'
            ? metadata.modelMode
            : null,
        permissionMode: resolvePermissionMode(metadata.permissionMode ?? undefined),
        effortLevel: metadata.effortLevel ?? null,
    });
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

export async function handleResumeCommand(args: string[]): Promise<void> {
    const parsed = parseResumeCommandArgs(args);
    if (parsed.showHelp) {
        console.log(formatResumeHelp());
        return;
    }

    const reconnectableSession = await resolveLocalReconnectableSession(parsed.sessionId);
    const bootstrap = buildResumeBootstrap(reconnectableSession);

    if (!existsSync(bootstrap.cwd)) {
        throw new Error(`Saved session path does not exist: ${bootstrap.cwd}`);
    }

    const exitCode = await resumeCodexGatewayTui(bootstrap);
    if (exitCode !== 0) {
        process.exit(exitCode);
    }
}

function resolvePermissionMode(
    value: string | undefined,
): CodexGatewayResumeBootstrap['permissionMode'] {
    if (!value || value === 'default') return 'default';
    if (value === 'read-only' || value === 'safe-yolo' || value === 'yolo') return value;
    throw new Error(`Unsupported Codex permission mode: '${value}'`);
}
