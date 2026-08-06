import type { ResumeEligibilityEntry } from './storage';
import type { Machine, Session } from './storageTypes';

export const RESUME_ELIGIBILITY_TTL_MS = 20_000;

export function buildResumeEligibilityFingerprint(
    session: Session,
    machine: Machine | null | undefined,
): string {
    return JSON.stringify({
        sessionId: session.id,
        active: session.active,
        archivedAt: session.archivedAt,
        originMachineId: session.originMachineId,
        machineDeletedAt: session.machineDeletedAt,
        flavor: session.metadata?.flavor ?? null,
        codexSyncVersion: session.metadata?.codexSyncVersion ?? null,
        codexReadOnly: session.metadata?.codexReadOnly === true,
        machineId: session.metadata?.machineId ?? null,
        directory: session.metadata?.path ?? null,
        threadId: session.metadata?.codexThreadId ?? null,
        machine: machine ? {
            id: machine.id,
            active: machine.active,
            resumeRpcAvailable: machine.metadata?.resumeSupport?.rpcAvailable === true,
            preflightRpcAvailable: machine.metadata?.resumeSupport?.preflightRpcAvailable === true,
            capabilityDetectedAt: machine.metadata?.resumeSupport?.detectedAt ?? null,
        } : null,
    });
}

export function isResumeEligibilityFresh(
    entry: ResumeEligibilityEntry | null | undefined,
    fingerprint: string,
    now: number = Date.now(),
): entry is ResumeEligibilityEntry {
    return Boolean(
        entry
        && entry.fingerprint === fingerprint
        && now >= entry.checkedAt
        && now - entry.checkedAt < RESUME_ELIGIBILITY_TTL_MS,
    );
}

export function resolveResumeEligibilityRefreshDelay(
    entries: readonly Pick<ResumeEligibilityEntry, 'checkedAt'>[],
    now: number = Date.now(),
): number | null {
    if (entries.length === 0) return null;

    const nextExpiry = Math.min(...entries.map((entry) => (
        entry.checkedAt + RESUME_ELIGIBILITY_TTL_MS
    )));
    return nextExpiry > now
        ? nextExpiry - now
        : 0;
}
