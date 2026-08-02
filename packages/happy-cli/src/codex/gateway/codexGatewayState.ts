import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    chmod,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
    stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { configuration } from '@/configuration';

export const CODEX_GATEWAY_STATE_VERSION = 1;

const idSchema = z.string().min(1).max(256);
const pathSchema = z.string().min(1).max(8_192);
const timestampSchema = z.number().int().nonnegative();

export const CodexGatewayBindingSchema = z.object({
    threadId: idSchema,
    sessionId: idSchema.nullable(),
    generation: z.number().int().nonnegative(),
    role: z.enum(['current', 'draining', 'inactive', 'recovering']),
    title: z.string().max(4_096).nullable(),
    changedAt: timestampSchema,
}).strict();
export type CodexGatewayBinding = z.infer<typeof CodexGatewayBindingSchema>;

export const CodexGatewayDescriptorSchema = z.object({
    version: z.literal(CODEX_GATEWAY_STATE_VERSION),
    gatewayId: idSchema,
    pid: z.number().int().positive(),
    processStartedAt: timestampSchema,
    createdAt: timestampSchema,
    heartbeatAt: timestampSchema,
    cwd: pathSchema,
    origin: z.enum(['terminal', 'app']),
    state: z.enum(['starting', 'running', 'recovering', 'stopping', 'stopped']),
    terminalState: z.enum(['attached', 'pendingDetach', 'detached', 'headless']),
    terminalDetachedAt: timestampSchema.nullable(),
    providerSocketPath: pathSchema.nullable(),
    tuiSocketPath: pathSchema.nullable(),
    controlSocketPath: pathSchema.nullable(),
    controlPort: z.number().int().min(1).max(65_535).nullable(),
    current: CodexGatewayBindingSchema.nullable(),
    draining: z.array(CodexGatewayBindingSchema).max(1_024),
    lastError: z.string().max(2_048).nullable(),
}).strict();
export type CodexGatewayDescriptor = z.infer<typeof CodexGatewayDescriptorSchema>;

export const CodexGatewaySecretSchema = z.object({
    version: z.literal(CODEX_GATEWAY_STATE_VERSION),
    gatewayId: idSchema,
    controlToken: z.string().min(32).max(512),
    normalExitNonce: z.string().min(32).max(512),
    sessionKeySeed: z.string().min(32).max(512),
}).strict();
export type CodexGatewaySecret = z.infer<typeof CodexGatewaySecretSchema>;

export interface CodexGatewayPaths {
    stateRoot: string;
    runtimeRoot: string;
    gatewayDir: string;
    runtimeDir: string;
    descriptorPath: string;
    secretPath: string;
    journalPath: string;
    providerSocketPath: string;
    tuiSocketPath: string;
    controlSocketPath: string;
}

export function codexGatewayStateRoot(happyHomeDir = configuration.happyHomeDir): string {
    return join(happyHomeDir, 'codex-gateways');
}

export function codexGatewayRuntimeRoot(
    happyHomeDir = configuration.happyHomeDir,
    systemTmpDir = tmpdir(),
): string {
    const profileHash = createHash('sha256').update(happyHomeDir).digest('hex').slice(0, 12);
    return join(systemTmpDir, `happy-codex-${profileHash}`);
}

export function codexGatewayPaths(
    gatewayId: string,
    options: { happyHomeDir?: string; runtimeRoot?: string } = {},
): CodexGatewayPaths {
    const safeId = z.string().uuid().parse(gatewayId);
    const happyHomeDir = options.happyHomeDir ?? configuration.happyHomeDir;
    const stateRoot = codexGatewayStateRoot(happyHomeDir);
    const runtimeRoot = options.runtimeRoot ?? codexGatewayRuntimeRoot(happyHomeDir);
    const shortId = safeId.replaceAll('-', '').slice(0, 16);
    const gatewayDir = join(stateRoot, safeId);
    const runtimeDir = join(runtimeRoot, shortId);
    return {
        stateRoot,
        runtimeRoot,
        gatewayDir,
        runtimeDir,
        descriptorPath: join(gatewayDir, 'descriptor.json'),
        secretPath: join(gatewayDir, 'secret.json'),
        journalPath: join(gatewayDir, 'gateway.jsonl'),
        providerSocketPath: join(runtimeDir, 'provider.sock'),
        tuiSocketPath: join(runtimeDir, 'tui.sock'),
        controlSocketPath: join(runtimeDir, 'control.sock'),
    };
}

export async function createCodexGatewayFiles(options: {
    cwd: string;
    origin: CodexGatewayDescriptor['origin'];
    happyHomeDir?: string;
    runtimeRoot?: string;
    now?: number;
}): Promise<{
    descriptor: CodexGatewayDescriptor;
    secret: CodexGatewaySecret;
    paths: CodexGatewayPaths;
}> {
    const gatewayId = randomUUID();
    const paths = codexGatewayPaths(gatewayId, options);
    await ensurePrivateDirectory(paths.stateRoot);
    await ensurePrivateDirectory(paths.runtimeRoot);
    await ensurePrivateDirectory(paths.gatewayDir);
    await ensurePrivateDirectory(paths.runtimeDir);
    const now = Math.max(0, Math.trunc(options.now ?? Date.now()));
    const secret: CodexGatewaySecret = {
        version: CODEX_GATEWAY_STATE_VERSION,
        gatewayId,
        controlToken: randomBytes(32).toString('base64url'),
        normalExitNonce: randomBytes(32).toString('base64url'),
        sessionKeySeed: randomBytes(32).toString('base64url'),
    };
    const descriptor: CodexGatewayDescriptor = {
        version: CODEX_GATEWAY_STATE_VERSION,
        gatewayId,
        pid: process.pid,
        processStartedAt: now,
        createdAt: now,
        heartbeatAt: now,
        cwd: options.cwd,
        origin: options.origin,
        state: 'starting',
        terminalState: options.origin === 'terminal' ? 'attached' : 'headless',
        terminalDetachedAt: null,
        providerSocketPath: process.platform === 'win32' ? null : paths.providerSocketPath,
        tuiSocketPath: process.platform === 'win32' ? null : paths.tuiSocketPath,
        controlSocketPath: process.platform === 'win32' ? null : paths.controlSocketPath,
        controlPort: null,
        current: null,
        draining: [],
        lastError: null,
    };
    await writePrivateJson(paths.secretPath, CodexGatewaySecretSchema.parse(secret));
    await writeCodexGatewayDescriptor(paths, descriptor);
    return { descriptor, secret, paths };
}

export async function readCodexGatewayDescriptor(
    descriptorPath: string,
): Promise<CodexGatewayDescriptor | null> {
    try {
        return CodexGatewayDescriptorSchema.parse(JSON.parse(await readFile(descriptorPath, 'utf8')));
    } catch {
        return null;
    }
}

export async function readCodexGatewaySecret(secretPath: string): Promise<CodexGatewaySecret | null> {
    try {
        return CodexGatewaySecretSchema.parse(JSON.parse(await readFile(secretPath, 'utf8')));
    } catch {
        return null;
    }
}

export async function writeCodexGatewayDescriptor(
    paths: CodexGatewayPaths,
    descriptor: CodexGatewayDescriptor,
): Promise<void> {
    await writePrivateJson(paths.descriptorPath, CodexGatewayDescriptorSchema.parse(descriptor));
}

export async function listCodexGatewayDescriptors(options: {
    happyHomeDir?: string;
} = {}): Promise<CodexGatewayDescriptor[]> {
    const root = codexGatewayStateRoot(options.happyHomeDir);
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const descriptors = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readCodexGatewayDescriptor(join(root, entry.name, 'descriptor.json'))));
    return descriptors
        .filter((entry): entry is CodexGatewayDescriptor => entry !== null)
        .sort((left, right) => right.heartbeatAt - left.heartbeatAt);
}

export async function removeCodexGatewayFiles(paths: CodexGatewayPaths): Promise<void> {
    await rm(paths.gatewayDir, { recursive: true, force: true });
    await rm(paths.runtimeDir, { recursive: true, force: true });
}

export async function assertPrivateFile(path: string): Promise<void> {
    if (process.platform === 'win32') return;
    const mode = (await stat(path)).mode & 0o777;
    if (mode !== 0o600) throw new Error(`Insecure Gateway file mode: ${mode.toString(8)}`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(path, 0o700);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
    await ensurePrivateDirectory(dirname(path));
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await rename(temporary, path);
        if (process.platform !== 'win32') await chmod(path, 0o600);
        await syncDirectory(dirname(path));
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function syncDirectory(path: string): Promise<void> {
    if (process.platform === 'win32') return;
    try {
        const handle = await open(path, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch {
        // Some filesystems do not support fsync on a directory.
    }
}
