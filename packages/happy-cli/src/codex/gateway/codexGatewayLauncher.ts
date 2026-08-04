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
    startCodexGatewayTuiRelay,
    type CodexGatewayTuiRelay,
} from './codexGatewayTuiRelay';
import {
    callCodexGatewayControl,
    type CodexGatewayOpenRootInput,
    type CodexGatewayOpenRootResult,
} from './codexGatewayControl';
import {
    codexGatewayPaths,
    CodexGatewayDescriptorSchema,
    CodexGatewayResumeBootstrapSchema,
    createCodexGatewayFiles,
    listCodexGatewayDescriptors,
    readCodexGatewayDescriptor,
    readCodexGatewaySecret,
    type CodexGatewayDescriptor,
    type CodexGatewayResumeBootstrap,
    type CodexGatewaySecret,
} from './codexGatewayState';
import {
    inspectCodexGatewayProviderProcess,
    inspectCodexGatewayWorkerProcess,
} from './codexGatewayProcessIdentity';

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
    resumeBootstrap?: CodexGatewayResumeBootstrap;
}

export interface CodexGatewayHeadlessLaunchResult extends CodexGatewayOpenRootResult {
    pid: number;
    descriptor: CodexGatewayDescriptor;
}

export type CodexGatewaySessionLiveness = 'live' | 'recovering' | 'missing';

export interface CodexGatewaySessionInspection {
    state: CodexGatewaySessionLiveness;
    gateway: {
        descriptor: CodexGatewayDescriptor;
        secret: CodexGatewaySecret;
    } | null;
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

export async function launchCodexGatewayResumeTui(
    input: CodexGatewayResumeBootstrap,
    env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
    assertMinimumCodexCliVersion();
    const bootstrap = CodexGatewayResumeBootstrapSchema.parse(input);
    const created = await createCodexGatewayFiles({
        cwd: bootstrap.cwd,
        origin: 'terminal',
        resumeBootstrap: bootstrap,
    });
    spawnCodexGatewayWorker(created.descriptor, env);
    try {
        const descriptor = await waitForGatewayReady(created.descriptor, created.secret);
        return await attachVerifiedCodexGateway({
            descriptor,
            secret: created.secret,
            threadId: bootstrap.threadId,
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
    assertHeadlessLaunchOptions(options);
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
        assertResumeBootstrapMatches(recoveredSecret.resumeBootstrap, options.resumeBootstrap ?? null);
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
            resumeBootstrap: options.resumeBootstrap,
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

    const protectedResume = options.action === 'resume' && options.resumeBootstrap !== undefined;
    const request: CodexGatewayOpenRootInput = {
        operationId,
        action: options.action,
        threadId: protectedResume
            ? null
            : options.action === 'resume' ? options.threadId ?? null : null,
        cwd: protectedResume ? null : options.cwd,
        model: protectedResume ? null : options.model ?? null,
        permissionMode: protectedResume ? 'default' : options.permissionMode ?? 'default',
        effortLevel: protectedResume ? null : options.effortLevel ?? null,
        parentSessionId: protectedResume ? null : options.parentSessionId ?? null,
        forkedFromMessageId: protectedResume ? null : options.forkedFromMessageId ?? null,
        isSideChat: protectedResume ? false : options.isSideChat ?? false,
    };
    let opened: CodexGatewayOpenRootResult;
    try {
        opened = await callCodexGatewayControl<CodexGatewayOpenRootResult>({
            descriptor,
            token: secret.controlToken,
            path: '/root/open',
            body: request,
            timeoutMs: 30_000,
        });
    } catch (error) {
        await callCodexGatewayControl({
            descriptor,
            token: secret.controlToken,
            path: '/root/cancel',
            body: { operationId },
            timeoutMs: 1_000,
        }).catch(() => undefined);
        await callCodexGatewayControl({
            descriptor,
            token: secret.controlToken,
            path: '/stop',
            body: { force: true },
            timeoutMs: 1_000,
        }).catch(() => undefined);
        throw error;
    }
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
        const status = await callCodexGatewayControl<unknown>({
            descriptor: options.descriptor,
            token: options.secret.controlToken,
            path: '/status',
            timeoutMs: 500,
        });
        return parseGatewayStatus(status, options.descriptor);
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
    return await attachVerifiedCodexGateway({
        descriptor: gateway.descriptor,
        secret: gateway.secret,
        threadId: gateway.descriptor.current.threadId,
    });
}

export async function attachVerifiedCodexGateway(options: {
    descriptor: CodexGatewayDescriptor;
    secret: CodexGatewaySecret;
    threadId: string;
}): Promise<number> {
    if (options.descriptor.gatewayId !== options.secret.gatewayId) {
        throw new Error('Codex Gateway attachment identity is inconsistent');
    }
    return await runAttachedTui({
        descriptor: options.descriptor,
        secret: options.secret,
        nativeArgs: ['resume', options.threadId],
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
    return await spawnForegroundCodex(args, process.env, process.cwd());
}

export function buildCodexRemoteArgs(
    remoteUrl: string,
    nativeArgs: string[],
): string[] {
    let endpoint: URL;
    try {
        endpoint = new URL(remoteUrl);
    } catch {
        throw new Error('Codex Gateway TUI endpoint is invalid');
    }
    if (
        endpoint.protocol !== 'ws:'
        || endpoint.hostname !== '127.0.0.1'
        || !endpoint.port
        || endpoint.username
        || endpoint.password
        || endpoint.pathname !== '/'
        || endpoint.search
        || endpoint.hash
    ) {
        throw new Error('Codex Gateway TUI endpoint must be authenticated loopback WebSocket');
    }
    return [
        '--remote',
        endpoint.toString(),
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
    const remote = await prepareCodexGatewayTuiRemote(
        options.descriptor,
        attachment.connectionToken,
    );
    try {
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
            buildCodexRemoteArgs(remote.remoteUrl, options.nativeArgs),
            {
                ...process.env,
                [REMOTE_TOKEN_ENV]: attachment.connectionToken,
            },
            options.descriptor.cwd,
        );
        if (result === 0) {
            await confirmNormalExit(options.descriptor, options.secret, attachment);
        }
        return result;
    } finally {
        await remote.close();
    }
}

async function prepareCodexGatewayTuiRemote(
    descriptor: CodexGatewayDescriptor,
    bearerToken: string,
): Promise<CodexGatewayTuiRelay> {
    if (descriptor.tuiSocketPath) {
        return await startCodexGatewayTuiRelay({
            upstreamSocketPath: descriptor.tuiSocketPath,
            bearerToken,
        });
    }
    if (!descriptor.tuiPort) {
        throw new Error('Codex Gateway TUI endpoint is unavailable');
    }
    return {
        remoteUrl: `ws://127.0.0.1:${descriptor.tuiPort}/`,
        close: async () => undefined,
    };
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
            const status = await callCodexGatewayControl<unknown>({
                descriptor: latest,
                token: secret.controlToken,
                path: '/status',
                timeoutMs: 1_000,
            });
            latest = parseGatewayStatus(status, descriptor);
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

export async function inspectVerifiedGatewayForSession(options: {
    sessionId: string;
    threadId: string;
}): Promise<CodexGatewaySessionInspection> {
    let recovering: CodexGatewaySessionInspection['gateway'] = null;
    for (const candidate of await listCodexGatewayDescriptors()) {
        if (candidate.state === 'stopped') continue;
        const paths = codexGatewayPaths(candidate.gatewayId);
        const [descriptor, secret] = await Promise.all([
            readCodexGatewayDescriptor(paths.descriptorPath),
            readCodexGatewaySecret(paths.secretPath),
        ]);
        if (!descriptor || !secret || descriptor.gatewayId !== secret.gatewayId) continue;
        const diskMatches = gatewayHasSessionBinding(descriptor, options);
        let rawStatus: unknown;
        try {
            rawStatus = await callCodexGatewayControl<unknown>({
                descriptor,
                token: secret.controlToken,
                path: '/status',
                timeoutMs: 500,
            });
        } catch {
            const workerIdentity = inspectCodexGatewayWorkerProcess({
                pid: descriptor.pid,
                gatewayId: descriptor.gatewayId,
            });
            if (
                diskMatches
                && (workerIdentity === 'expected' || workerIdentity === 'unverified')
            ) {
                recovering = { descriptor, secret };
            }
            continue;
        }
        let status: CodexGatewayDescriptor;
        try {
            status = parseGatewayStatus(rawStatus, descriptor);
        } catch {
            const workerIdentity = inspectCodexGatewayWorkerProcess({
                pid: descriptor.pid,
                gatewayId: descriptor.gatewayId,
            });
            if (
                diskMatches
                && (workerIdentity === 'expected' || workerIdentity === 'unverified')
            ) {
                recovering = { descriptor, secret };
            }
            continue;
        }
        const workerIdentity = inspectCodexGatewayWorkerProcess({
            pid: status.pid,
            gatewayId: status.gatewayId,
        });
        if (workerIdentity === 'absent' || workerIdentity === 'unexpected') continue;

        const currentMatches = gatewayCurrentMatches(status, options);
        const drainingMatches = gatewayDrainingMatches(status, options);
        if (!currentMatches && !drainingMatches) continue;

        const gateway = { descriptor: status, secret };
        const providerIdentity = inspectProviderIdentity(status, paths.providerTokenPath);
        if (
            currentMatches
            && status.state === 'running'
            && workerIdentity === 'expected'
            && providerIdentity === 'expected'
        ) {
            return { state: 'live', gateway };
        }
        if (status.state !== 'stopped') recovering = gateway;
    }
    return recovering
        ? { state: 'recovering', gateway: recovering }
        : { state: 'missing', gateway: null };
}

function gatewayHasSessionBinding(
    descriptor: CodexGatewayDescriptor,
    options: { sessionId: string; threadId: string },
): boolean {
    return gatewayCurrentMatches(descriptor, options) || gatewayDrainingMatches(descriptor, options);
}

function gatewayCurrentMatches(
    descriptor: CodexGatewayDescriptor,
    options: { sessionId: string; threadId: string },
): boolean {
    return descriptor.current?.sessionId === options.sessionId
        && descriptor.current.threadId === options.threadId;
}

function gatewayDrainingMatches(
    descriptor: CodexGatewayDescriptor,
    options: { sessionId: string; threadId: string },
): boolean {
    return descriptor.draining.some((binding) => (
        binding.sessionId === options.sessionId && binding.threadId === options.threadId
    ));
}

export async function reconcileVerifiedGatewayPresence(options: {
    gateway: NonNullable<CodexGatewaySessionInspection['gateway']>;
    sessionId: string;
}): Promise<void> {
    const result = await callCodexGatewayControl<{ reconciled?: boolean }>({
        descriptor: options.gateway.descriptor,
        token: options.gateway.secret.controlToken,
        path: '/presence/reconcile',
        body: { sessionId: options.sessionId },
    });
    if (result.reconciled !== true) {
        throw new Error('Codex Gateway did not reconcile session presence');
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
            const rawStatus = await callCodexGatewayControl<unknown>({
                descriptor,
                token: secret.controlToken,
                path: '/status',
                timeoutMs: 500,
            });
            const status = parseGatewayStatus(rawStatus, descriptor);
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

async function spawnForegroundCodex(
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
): Promise<number> {
    const child = crossSpawn('codex', args, {
        cwd,
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

function assertHeadlessLaunchOptions(options: CodexGatewayHeadlessLaunchOptions): void {
    if (options.resumeBootstrap) {
        const bootstrap = CodexGatewayResumeBootstrapSchema.parse(options.resumeBootstrap);
        if (options.action !== 'resume') {
            throw new Error('A Codex Gateway resume bootstrap requires the resume action');
        }
        if (bootstrap.cwd !== options.cwd) {
            throw new Error('Codex Gateway resume bootstrap working directory changed');
        }
        if (
            options.threadId !== undefined
            || options.model !== undefined
            || options.permissionMode !== undefined
            || options.effortLevel !== undefined
            || options.parentSessionId !== undefined
            || options.forkedFromMessageId !== undefined
            || options.isSideChat !== undefined
        ) {
            throw new Error('Codex Gateway resume material must be supplied only through the private bootstrap');
        }
        return;
    }
    if (options.action === 'resume' && !options.threadId) {
        throw new Error('Codex thread ID is required for a new-session resume');
    }
    if (options.action === 'start' && options.threadId) {
        throw new Error('Codex thread ID is not allowed for a new thread');
    }
}

function assertResumeBootstrapMatches(
    persisted: CodexGatewayResumeBootstrap | null,
    requested: CodexGatewayResumeBootstrap | null,
): void {
    const left = persisted ? CodexGatewayResumeBootstrapSchema.parse(persisted) : null;
    const right = requested ? CodexGatewayResumeBootstrapSchema.parse(requested) : null;
    if (JSON.stringify(left) !== JSON.stringify(right)) {
        throw new Error('Codex Gateway App operation changed its private resume bootstrap');
    }
}

function parseGatewayStatus(
    input: unknown,
    expected: CodexGatewayDescriptor,
): CodexGatewayDescriptor {
    const status = CodexGatewayDescriptorSchema.parse(input);
    if (
        status.gatewayId !== expected.gatewayId
        || status.origin !== expected.origin
        || status.cwd !== expected.cwd
        || status.bootstrapOperationId !== expected.bootstrapOperationId
    ) {
        throw new Error('Codex Gateway status identity is inconsistent');
    }
    return status;
}

function inspectProviderIdentity(
    descriptor: CodexGatewayDescriptor,
    tokenFilePath: string,
): ReturnType<typeof inspectCodexGatewayProviderProcess> {
    if (!descriptor.providerPid) return 'absent';
    const listenEndpoint = descriptor.providerSocketPath
        ? `unix://${descriptor.providerSocketPath}`
        : descriptor.providerPort
            ? `ws://127.0.0.1:${descriptor.providerPort}`
            : null;
    if (!listenEndpoint) return 'unverified';
    return inspectCodexGatewayProviderProcess({
        pid: descriptor.providerPid,
        listenEndpoint,
        tokenFilePath: descriptor.providerSocketPath ? undefined : tokenFilePath,
    });
}
