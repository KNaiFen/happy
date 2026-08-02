import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { spawn as crossSpawn } from 'cross-spawn';
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning';
import { sanitizeSessionEnvironment } from '@/daemon/sessionEnvironment';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { assertMinimumCodexCliVersion } from '../codexCliVersion';
import { createCodexGatewayAttachmentCredentials } from './codexGatewayAttachment';
import {
    callCodexGatewayControl,
    type CodexGatewayOpenRootInput,
    type CodexGatewayOpenRootResult,
} from './codexGatewayControl';
import {
    codexGatewayPaths,
    createCodexGatewayFiles,
    listCodexGatewayDescriptors,
    readCodexGatewayDescriptor,
    readCodexGatewaySecret,
    type CodexGatewayDescriptor,
    type CodexGatewaySecret,
} from './codexGatewayState';

const WORKER_READY_TIMEOUT_MS = 20_000;
const WORKER_READY_POLL_MS = 50;
const NORMAL_EXIT_RETRIES = 20;
const NORMAL_EXIT_RETRY_MS = 50;
const REMOTE_TOKEN_ENV = 'HAPPY_CODEX_GATEWAY_REMOTE_TOKEN';

export interface CodexGatewayHeadlessLaunchOptions {
    operationId?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    action: 'start' | 'resume';
    threadId?: string;
    model?: string;
    permissionMode?: 'default' | 'read-only' | 'safe-yolo' | 'yolo';
    effortLevel?: string;
    parentSessionId?: string;
    forkedFromMessageId?: string;
    isSideChat?: boolean;
    existingSession?: {
        sessionId: string;
        dataEncryptionKey: string;
    };
}

export interface CodexGatewayHeadlessLaunchResult extends CodexGatewayOpenRootResult {
    pid: number;
    descriptor: CodexGatewayDescriptor;
}

export async function launchCodexGatewayTui(nativeArgs: string[]): Promise<number> {
    assertMinimumCodexCliVersion();
    await authAndSetupMachineIfNeeded();
    await ensureDaemonRunning();
    const created = await createCodexGatewayFiles({
        cwd: process.cwd(),
        origin: 'terminal',
    });
    const worker = spawnHappyCLI(
        ['__codex-gateway-worker', created.descriptor.gatewayId],
        {
            cwd: process.cwd(),
            detached: true,
            stdio: 'ignore',
            env: sanitizeSessionEnvironment(process.env),
        },
    );
    if (!worker.pid) throw new Error('Codex Gateway worker did not start');
    worker.unref();

    try {
        const descriptor = await waitForGatewayReady(created.descriptor, created.secret);
        return await runAttachedTui({
            descriptor,
            secret: created.secret,
            nativeArgs,
        });
    } catch (error) {
        const latest = await readCodexGatewayDescriptor(created.paths.descriptorPath)
            ?? created.descriptor;
        await callCodexGatewayControl({
            descriptor: latest,
            token: created.secret.controlToken,
            path: '/stop',
            body: { force: true },
            timeoutMs: 1_000,
        }).catch(() => undefined);
        throw error;
    }
}

export async function launchCodexGatewayHeadless(
    options: CodexGatewayHeadlessLaunchOptions,
): Promise<CodexGatewayHeadlessLaunchResult> {
    assertMinimumCodexCliVersion();
    const operationId = options.operationId ?? randomUUID();
    let descriptor: CodexGatewayDescriptor;
    let secret: CodexGatewaySecret;
    const existing = (await listCodexGatewayDescriptors()).filter((candidate) => (
        candidate.origin === 'app'
        && candidate.bootstrapOperationId === operationId
        && candidate.state !== 'stopped'
    ));
    if (existing.length > 1) {
        throw new Error('More than one Codex Gateway matched the App operation');
    }
    if (existing[0]) {
        if (existing[0].cwd !== options.cwd) {
            throw new Error('Codex Gateway App operation changed its working directory');
        }
        const paths = codexGatewayPaths(existing[0].gatewayId);
        const recoveredSecret = await readCodexGatewaySecret(paths.secretPath);
        if (!recoveredSecret) throw new Error('Codex Gateway recovery secret is unavailable');
        secret = recoveredSecret;
        descriptor = await ensureCodexGatewayRunning({
            descriptor: existing[0],
            secret,
            env: options.env,
        });
    } else {
        const created = await createCodexGatewayFiles({
            cwd: options.cwd,
            origin: 'app',
            bootstrapOperationId: operationId,
        });
        secret = created.secret;
        spawnCodexGatewayWorker(created.descriptor, options.env);
        try {
            descriptor = await waitForGatewayReady(created.descriptor, created.secret);
        } catch (error) {
            const latest = await readCodexGatewayDescriptor(created.paths.descriptorPath)
                ?? created.descriptor;
            await callCodexGatewayControl({
                descriptor: latest,
                token: created.secret.controlToken,
                path: '/stop',
                body: { force: true },
                timeoutMs: 1_000,
            }).catch(() => undefined);
            throw error;
        }
    }

    const request: CodexGatewayOpenRootInput = {
        operationId,
        action: options.action,
        threadId: options.action === 'resume' ? options.threadId ?? null : null,
        cwd: options.cwd,
        model: options.model ?? null,
        permissionMode: options.permissionMode ?? 'default',
        effortLevel: options.effortLevel ?? null,
        parentSessionId: options.parentSessionId ?? null,
        forkedFromMessageId: options.forkedFromMessageId ?? null,
        isSideChat: options.isSideChat ?? false,
        happySessionId: options.existingSession?.sessionId ?? null,
        dataEncryptionKey: options.existingSession?.dataEncryptionKey ?? null,
    };
    let opened: CodexGatewayOpenRootResult | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            opened = await callCodexGatewayControl<CodexGatewayOpenRootResult>({
                descriptor,
                token: secret.controlToken,
                path: '/root/open',
                body: request,
                timeoutMs: 30_000,
            });
            break;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
    }
    if (!opened) throw lastError instanceof Error ? lastError : new Error('Codex Gateway root did not open');
    return {
        ...opened,
        pid: descriptor.pid,
        descriptor,
    };
}

export async function ensureCodexGatewayRunning(options: {
    descriptor: CodexGatewayDescriptor;
    secret: CodexGatewaySecret;
    env?: NodeJS.ProcessEnv;
}): Promise<CodexGatewayDescriptor> {
    if (options.descriptor.gatewayId !== options.secret.gatewayId) {
        throw new Error('Codex Gateway recovery identity is inconsistent');
    }
    if (options.descriptor.state === 'stopped') {
        throw new Error('A stopped Codex Gateway cannot be recovered');
    }
    try {
        return await callCodexGatewayControl<CodexGatewayDescriptor>({
            descriptor: options.descriptor,
            token: options.secret.controlToken,
            path: '/status',
            timeoutMs: 500,
        });
    } catch {
        spawnCodexGatewayWorker(options.descriptor, options.env ?? process.env);
        return await waitForGatewayReady(options.descriptor, options.secret);
    }
}

export async function attachCodexGateway(selector?: string): Promise<number> {
    assertMinimumCodexCliVersion();
    const gateway = await selectGateway('attach', selector);
    if (!gateway.descriptor.current) {
        throw new Error('The selected Codex Gateway has no current thread to attach');
    }
    return await runAttachedTui({
        descriptor: gateway.descriptor,
        secret: gateway.secret,
        nativeArgs: ['resume', gateway.descriptor.current.threadId],
    });
}

export async function stopCodexGateway(options: {
    selector?: string;
    force: boolean;
}): Promise<void> {
    const gateway = await selectGateway('stop', options.selector);
    await callCodexGatewayControl({
        descriptor: gateway.descriptor,
        token: gateway.secret.controlToken,
        path: '/stop',
        body: { force: options.force },
    });
}

export async function delegateToOfficialCodex(args: string[]): Promise<number> {
    assertMinimumCodexCliVersion();
    return await spawnForegroundCodex(args, process.env);
}

export function buildCodexRemoteArgs(
    descriptor: CodexGatewayDescriptor,
    nativeArgs: string[],
): string[] {
    const endpoint = descriptor.tuiSocketPath
        ? `unix://${descriptor.tuiSocketPath}`
        : descriptor.tuiPort
            ? `ws://127.0.0.1:${descriptor.tuiPort}`
            : null;
    if (!endpoint) {
        throw new Error('Codex Gateway TUI endpoint is unavailable');
    }
    return [
        '--remote',
        endpoint,
        '--remote-auth-token-env',
        REMOTE_TOKEN_ENV,
        ...nativeArgs,
    ];
}

async function runAttachedTui(options: {
    descriptor: CodexGatewayDescriptor;
    secret: CodexGatewaySecret;
    nativeArgs: string[];
}): Promise<number> {
    const attachment = createCodexGatewayAttachmentCredentials();
    const registration = await callCodexGatewayControl<{ accepted: boolean }>({
        descriptor: options.descriptor,
        token: options.secret.controlToken,
        path: '/terminal-attached',
        body: attachment,
    });
    if (!registration.accepted) {
        throw new Error('This Codex Gateway already has an attached terminal');
    }
    const result = await spawnForegroundCodex(
        buildCodexRemoteArgs(options.descriptor, options.nativeArgs),
        {
            ...process.env,
            [REMOTE_TOKEN_ENV]: attachment.connectionToken,
        },
    );
    if (result === 0) {
        await confirmNormalExit(options.descriptor, options.secret, attachment);
    }
    return result;
}

async function confirmNormalExit(
    descriptor: CodexGatewayDescriptor,
    secret: CodexGatewaySecret,
    attachment: ReturnType<typeof createCodexGatewayAttachmentCredentials>,
): Promise<void> {
    for (let attempt = 0; attempt < NORMAL_EXIT_RETRIES; attempt += 1) {
        const result = await callCodexGatewayControl<{
            accepted: boolean;
            reason?: 'notPending' | 'staleAttachment' | 'invalidNonce';
        }>({
            descriptor,
            token: secret.controlToken,
            path: '/normal-exit',
            body: {
                attachmentId: attachment.attachmentId,
                nonce: attachment.normalExitNonce,
            },
            timeoutMs: 1_000,
        }).catch(() => null);
        if (result?.accepted) return;
        if (result?.reason && result.reason !== 'notPending') return;
        await new Promise((resolve) => setTimeout(resolve, NORMAL_EXIT_RETRY_MS));
    }
}

export async function waitForGatewayReady(
    descriptor: CodexGatewayDescriptor,
    secret: CodexGatewaySecret,
    timing: { timeoutMs?: number; pollMs?: number } = {},
): Promise<CodexGatewayDescriptor> {
    const timeoutMs = timing.timeoutMs ?? WORKER_READY_TIMEOUT_MS;
    const pollMs = timing.pollMs ?? WORKER_READY_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    let latest = descriptor;
    const descriptorPath = codexGatewayPaths(descriptor.gatewayId).descriptorPath;
    while (Date.now() < deadline) {
        latest = await readCodexGatewayDescriptor(descriptorPath) ?? latest;
        assertGatewayDidNotStopDuringStartup(latest);
        if (!latest.controlSocketPath && !latest.controlPort) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            continue;
        }
        try {
            latest = await callCodexGatewayControl<CodexGatewayDescriptor>({
                descriptor: latest,
                token: secret.controlToken,
                path: '/status',
                timeoutMs: 1_000,
            });
            if (latest.state === 'running') return latest;
            assertGatewayDidNotStopDuringStartup(latest);
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('Codex Gateway stopped')) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(
        `Codex Gateway did not become ready within ${timeoutMs}ms `
        + `(state=${latest.state}, error=${latest.lastError ?? 'none'})`,
    );
}

function assertGatewayDidNotStopDuringStartup(descriptor: CodexGatewayDescriptor): void {
    if (descriptor.state !== 'stopped') return;
    throw new Error(`Codex Gateway stopped during startup (${descriptor.lastError ?? 'unknown'})`);
}

async function selectGateway(
    operation: 'attach' | 'stop',
    selector?: string,
): Promise<{ descriptor: CodexGatewayDescriptor; secret: CodexGatewaySecret }> {
    const gateways = (await discoverLiveCodexGateways({ recover: true }))
        .filter(({ descriptor }) => operation === 'stop' || descriptor.state !== 'stopping');
    if (gateways.length === 0) throw new Error('No live Codex Gateways were found');
    if (selector) {
        const exact = gateways.filter(({ descriptor }) => (
            descriptor.gatewayId === selector || descriptor.current?.threadId === selector
        ));
        if (exact.length !== 1) {
            throw new Error(exact.length === 0
                ? 'No live Codex Gateway matched that ID'
                : 'More than one Codex Gateway matched that ID');
        }
        return exact[0];
    }
    if (!stdin.isTTY || !stdout.isTTY) {
        throw new Error(`happy codex ${operation} requires a Gateway or thread ID without an interactive terminal`);
    }
    stdout.write(`Select a Codex Gateway to ${operation}:\n`);
    gateways.forEach(({ descriptor }, index) => {
        const title = descriptor.current?.title || 'Untitled Codex session';
        const state = `${descriptor.state}/${descriptor.terminalState}`;
        stdout.write(`${index + 1}. ${title}  ${descriptor.cwd}  ${state}  ${descriptor.gatewayId.slice(0, 8)}\n`);
    });
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
        const answer = await prompt.question('Selection: ');
        const index = Number(answer) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= gateways.length) {
            throw new Error('Invalid Codex Gateway selection');
        }
        return gateways[index];
    } finally {
        prompt.close();
    }
}

export async function discoverLiveCodexGateways(options: {
    recover?: boolean;
    env?: NodeJS.ProcessEnv;
} = {}): Promise<Array<{
    descriptor: CodexGatewayDescriptor;
    secret: CodexGatewaySecret;
}>> {
    const descriptors = await listCodexGatewayDescriptors();
    const discovered = await Promise.all(descriptors.map(async (descriptor): Promise<{
        descriptor: CodexGatewayDescriptor;
        secret: CodexGatewaySecret;
    } | null> => {
        if (descriptor.state === 'stopped' || (descriptor.state === 'stopping' && !options.recover)) return null;
        const paths = codexGatewayPaths(descriptor.gatewayId);
        const secret = await readCodexGatewaySecret(paths.secretPath);
        if (!secret) return null;
        try {
            const status = await callCodexGatewayControl<CodexGatewayDescriptor>({
                descriptor,
                token: secret.controlToken,
                path: '/status',
                timeoutMs: 500,
            });
            if (
                status.state !== 'stopped'
                && (status.state !== 'stopping' || options.recover)
            ) {
                return { descriptor: status, secret };
            }
            return null;
        } catch {
            if (!options.recover) return null;
            try {
                const recovered = await ensureCodexGatewayRunning({
                    descriptor,
                    secret,
                    env: options.env,
                });
                return recovered.state !== 'stopped'
                    ? { descriptor: recovered, secret }
                    : null;
            } catch {
                // A live lease owner or an unrecoverable descriptor remains untouched.
                return null;
            }
        }
    }));
    return discovered.filter((entry): entry is {
        descriptor: CodexGatewayDescriptor;
        secret: CodexGatewaySecret;
    } => entry !== null);
}

function spawnCodexGatewayWorker(
    descriptor: CodexGatewayDescriptor,
    env: NodeJS.ProcessEnv,
): number {
    const worker = spawnHappyCLI(
        ['__codex-gateway-worker', descriptor.gatewayId],
        {
            cwd: descriptor.cwd,
            detached: true,
            stdio: 'ignore',
            env: sanitizeSessionEnvironment(env),
        },
    );
    if (!worker.pid) throw new Error('Codex Gateway worker did not start');
    worker.unref();
    return worker.pid;
}

async function spawnForegroundCodex(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
    const child = crossSpawn('codex', args, {
        cwd: process.cwd(),
        env,
        stdio: 'inherit',
        windowsHide: false,
    });
    return await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                resolve(1);
                return;
            }
            resolve(code ?? 1);
        });
    });
}
