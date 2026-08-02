import type { TrackedSession } from './types';
import { isExpectedLegacyHappyCodexAdapterProcess } from '@/codex/gateway/codexGatewayProcessIdentity';

export interface LegacyCodexAdapterRetirementOptions {
    happyHomeDir: string;
    happyLibDir: string;
    isExpectedProcess?: (pid: number) => boolean;
    signal?: (pid: number) => void;
}

export function isVerifiedLegacyCodexAdapterSession(
    tracked: TrackedSession,
    options: Pick<LegacyCodexAdapterRetirementOptions, 'happyHomeDir' | 'happyLibDir'>,
): boolean {
    const metadata = tracked.happySessionMetadataFromLocalWebhook;
    return tracked.startedBy === 'persisted'
        && tracked.codexGatewayId === undefined
        && Number.isInteger(tracked.pid)
        && tracked.pid > 0
        && metadata?.flavor === 'codex'
        && metadata.startedBy === 'daemon'
        && metadata.hostPid === tracked.pid
        && metadata.happyHomeDir === options.happyHomeDir
        && metadata.happyLibDir === options.happyLibDir
        && metadata.codexGatewayBinding === undefined;
}

export function retireVerifiedLegacyCodexAdapters(
    sessions: Iterable<TrackedSession>,
    options: LegacyCodexAdapterRetirementOptions,
): number {
    const isExpectedProcess = options.isExpectedProcess
        ?? ((pid: number) => isExpectedLegacyHappyCodexAdapterProcess({ pid }));
    const signal = options.signal ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
    const handledPids = new Set<number>();
    let retired = 0;

    for (const tracked of sessions) {
        if (!isVerifiedLegacyCodexAdapterSession(tracked, options)) continue;
        if (handledPids.has(tracked.pid)) continue;
        handledPids.add(tracked.pid);
        if (!isExpectedProcess(tracked.pid)) continue;
        try {
            // Narrow the PID-reuse window before signalling. A failed second inspection is a skip.
            if (!isExpectedProcess(tracked.pid)) continue;
            signal(tracked.pid);
            retired += 1;
        } catch {
            // A verified adapter may exit between the final inspection and the signal.
        }
    }
    return retired;
}
