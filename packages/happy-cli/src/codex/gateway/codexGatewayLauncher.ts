import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn as crossSpawn } from 'cross-spawn';
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning';
import { sanitizeSessionEnvironment } from '@/daemon/sessionEnvironment';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { assertMinimumCodexCliVersion } from '../codexCliVersion';
import { createCodexGatewayAttachmentCredentials } from './codexGatewayAttachment';
import { callCodexGatewayControl } from './codexGatewayControl';
import {
    codexGatewayPaths,
    createCodexGatewayFiles,
    listCodexGatewayDescriptors,
    readCodexGatewaySecret,
    type CodexGatewayDescriptor,
    type CodexGatewaySecret,
} from './codexGatewayState';

const WORKER_READY_TIMEOUT_MS = 20_000;
const WORKER_READY_POLL_MS = 50;
const NORMAL_EXIT_RETRIES = 20;
const NORMAL_EXIT_RETRY_MS = 50;
const REMOTE_TOKEN_ENV = 'HAPPY_CODEX_GATEWAY_REMOTE_TOKEN';

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
        await callCodexGatewayControl({
            descriptor: created.descriptor,
            token: created.secret.controlToken,
            path: '/stop',
            body: { force: true },
            timeoutMs: 1_000,
        }).catch(() => undefined);
        throw error;
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
    if (!descriptor.tuiSocketPath) {
        throw new Error('Codex Gateway TUI endpoint is unavailable');
    }
    return [
        '--remote',
        `unix://${descriptor.tuiSocketPath}`,
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

async function waitForGatewayReady(
    descriptor: CodexGatewayDescriptor,
    secret: CodexGatewaySecret,
): Promise<CodexGatewayDescriptor> {
    const deadline = Date.now() + WORKER_READY_TIMEOUT_MS;
    let latest = descriptor;
    while (Date.now() < deadline) {
        try {
            latest = await callCodexGatewayControl<CodexGatewayDescriptor>({
                descriptor: latest,
                token: secret.controlToken,
                path: '/status',
                timeoutMs: 1_000,
            });
            if (latest.state === 'running') return latest;
            if (latest.state === 'stopped') {
                throw new Error(`Codex Gateway stopped during startup (${latest.lastError ?? 'unknown'})`);
            }
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('Codex Gateway stopped')) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, WORKER_READY_POLL_MS));
    }
    throw new Error(`Codex Gateway did not become ready within ${WORKER_READY_TIMEOUT_MS}ms`);
}

async function selectGateway(
    operation: 'attach' | 'stop',
    selector?: string,
): Promise<{ descriptor: CodexGatewayDescriptor; secret: CodexGatewaySecret }> {
    const gateways = await discoverLiveGateways();
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

async function discoverLiveGateways(): Promise<Array<{
    descriptor: CodexGatewayDescriptor;
    secret: CodexGatewaySecret;
}>> {
    const descriptors = await listCodexGatewayDescriptors();
    const live: Array<{ descriptor: CodexGatewayDescriptor; secret: CodexGatewaySecret }> = [];
    for (const descriptor of descriptors) {
        if (descriptor.state === 'stopped' || descriptor.state === 'stopping') continue;
        const paths = codexGatewayPaths(descriptor.gatewayId);
        const secret = await readCodexGatewaySecret(paths.secretPath);
        if (!secret) continue;
        try {
            const status = await callCodexGatewayControl<CodexGatewayDescriptor>({
                descriptor,
                token: secret.controlToken,
                path: '/status',
                timeoutMs: 500,
            });
            live.push({ descriptor: status, secret });
        } catch {
            // Stale or inaccessible descriptors are excluded from the selector.
        }
    }
    return live;
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
