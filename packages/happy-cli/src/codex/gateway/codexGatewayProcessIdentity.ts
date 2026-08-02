import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';

export type CodexGatewayProviderProcessIdentity =
    | 'expected'
    | 'absent'
    | 'unexpected'
    | 'unverified';

export function isExpectedCodexGatewayWorkerProcess(options: {
    pid: number;
    gatewayId: string;
    entrypoint?: string;
    isAlive?: (pid: number) => boolean;
    readCommandLine?: (pid: number) => string | null;
}): boolean {
    if (!Number.isInteger(options.pid) || options.pid <= 0) return false;
    if (options.pid === process.pid) return true;
    const isAlive = options.isAlive ?? processIsAlive;
    if (!isAlive(options.pid)) return false;
    const commandLine = (options.readCommandLine ?? readProcessCommandLine)(options.pid);
    if (commandLine === null) {
        // A transient inspection failure must not create a second journal owner.
        return true;
    }
    const entrypoint = options.entrypoint ?? join(projectPath(), 'dist', 'index.mjs');
    return commandLine.includes(entrypoint)
        && commandLine.includes('__codex-gateway-worker')
        && commandLine.includes(options.gatewayId);
}

export function isExpectedCodexGatewayProviderProcess(options: {
    pid: number;
    listenEndpoint: string;
    tokenFilePath?: string;
    isAlive?: (pid: number) => boolean;
    readCommandLine?: (pid: number) => string | null;
}): boolean {
    return inspectCodexGatewayProviderProcess(options) === 'expected';
}

export function inspectCodexGatewayProviderProcess(options: {
    pid: number;
    listenEndpoint: string;
    tokenFilePath?: string;
    isAlive?: (pid: number) => boolean;
    readCommandLine?: (pid: number) => string | null;
}): CodexGatewayProviderProcessIdentity {
    if (!Number.isInteger(options.pid) || options.pid <= 0) return 'absent';
    const isAlive = options.isAlive ?? processIsAlive;
    if (!isAlive(options.pid)) return 'absent';
    const commandLine = (options.readCommandLine ?? readProcessCommandLine)(options.pid);
    if (!commandLine) return 'unverified';
    if (!/codex/i.test(commandLine)) return 'unexpected';
    if (!commandLine.includes('app-server')) return 'unexpected';
    if (!commandLine.includes('--listen') || !commandLine.includes(options.listenEndpoint)) {
        return 'unexpected';
    }
    if (options.tokenFilePath && (
        !commandLine.includes('--ws-token-file')
        || !commandLine.includes(options.tokenFilePath)
    )) return 'unexpected';
    return 'expected';
}

export function isExpectedLegacyHappyCodexAdapterProcess(options: {
    pid: number;
    entrypoint?: string;
    isAlive?: (pid: number) => boolean;
    readCommandLine?: (pid: number) => string | null;
}): boolean {
    if (!Number.isInteger(options.pid) || options.pid <= 0) return false;
    const isAlive = options.isAlive ?? processIsAlive;
    if (!isAlive(options.pid)) return false;
    const commandLine = (options.readCommandLine ?? readProcessCommandLine)(options.pid);
    if (!commandLine) return false;
    const entrypoint = options.entrypoint ?? join(projectPath(), 'dist', 'index.mjs');
    return isHappyNodeRuntimeCommand(commandLine)
        && commandLine.includes(entrypoint)
        && /(?:^|\s)--no-warnings(?:\s|$)/.test(commandLine)
        && /(?:^|\s)--no-deprecation(?:\s|$)/.test(commandLine)
        && /(?:^|\s)codex(?:\s|$)/.test(commandLine)
        && commandLine.includes('--happy-starting-mode remote')
        && commandLine.includes('--started-by daemon')
        && !commandLine.includes('__codex-gateway-worker')
        && !commandLine.includes('--remote');
}

function isHappyNodeRuntimeCommand(commandLine: string): boolean {
    const match = commandLine.trimStart().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const executable = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!executable) return false;
    const filename = executable.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
    return filename === 'node'
        || filename === 'node.exe'
        || filename === 'bun'
        || filename === 'bun.exe';
}

export function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function readProcessCommandLine(pid: number): string | null {
    const result = process.platform === 'win32'
        ? spawnSync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 1_000,
        })
        : spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 1_000,
        });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const commandLine = result.stdout.trim();
    return commandLine.length > 0 ? commandLine : null;
}
