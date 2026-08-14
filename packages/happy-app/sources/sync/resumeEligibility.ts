import * as React from 'react';

import { encodeBase64 } from '@/encryption/base64';
import { isMachineOnline } from '@/utils/machineUtils';
import { isSessionMachineDeleted } from './sessionMachineAccess';
import {
    machinePreflightResumeSessions,
    type PreflightResumeSessionInput,
    type PreflightResumeSessionResult,
} from './ops';
import {
    storage,
    type ResumeEligibilityEntry,
    type ResumeEligibilityReason,
} from './storage';
import type { Machine, Session } from './storageTypes';
import { sync } from './sync';
import {
    buildResumeEligibilityFingerprint,
    isResumeEligibilityFresh,
    RESUME_ELIGIBILITY_TTL_MS,
    resolveResumeEligibilityRefreshDelay,
} from './resumeEligibilityState';

export {
    buildResumeEligibilityFingerprint,
    isResumeEligibilityFresh,
    RESUME_ELIGIBILITY_TTL_MS,
    resolveResumeEligibilityRefreshDelay,
} from './resumeEligibilityState';

type InFlightPreflight = {
    fingerprint: string;
    promise: Promise<void>;
};

type PreflightCandidate = {
    sessionId: string;
    fingerprint: string;
    checkedAt: number;
    input: PreflightResumeSessionInput;
};

const inFlightBySessionId = new Map<string, InFlightPreflight>();

export async function ensureResumeEligibilityForSessions(options: {
    sessions: readonly Session[];
    machines: readonly Machine[];
    machinesLoaded: boolean;
    forceSessionIds?: ReadonlySet<string>;
}): Promise<void> {
    const now = Date.now();
    const machineById = new Map(options.machines.map((machine) => [machine.id, machine]));
    const machineRecord = Object.fromEntries(options.machines.map((machine) => [machine.id, machine]));
    const immediateEntries: Record<string, ResumeEligibilityEntry> = {};
    const candidatesByMachine = new Map<string, PreflightCandidate[]>();
    const existingPromises = new Set<Promise<void>>();

    for (const session of options.sessions) {
        if (session.active || session.archivedAt !== null) continue;

        const machineId = session.metadata?.machineId;
        const machine = machineId ? machineById.get(machineId) : undefined;
        const fingerprint = buildResumeEligibilityFingerprint(session, machine);
        const current = storage.getState().resumeEligibilityBySessionId[session.id];
        if (
            !options.forceSessionIds?.has(session.id)
            && isResumeEligibilityFresh(current, fingerprint, now)
        ) {
            continue;
        }

        const existing = inFlightBySessionId.get(session.id);
        if (existing?.fingerprint === fingerprint) {
            existingPromises.add(existing.promise);
            continue;
        }

        const localEntry = resolveLocalEligibility({
            session,
            machine,
            machinesLoaded: options.machinesLoaded,
            machineRecord,
            fingerprint,
            checkedAt: now,
        });
        if (localEntry) {
            immediateEntries[session.id] = localEntry;
            continue;
        }

        const directory = session.metadata?.path;
        const threadId = session.metadata?.codexThreadId;
        const dataKey = sync.encryption.getIndependentSessionDataKey(session.id);
        if (!machineId || !directory || !threadId || !dataKey) {
            immediateEntries[session.id] = {
                fingerprint,
                state: 'ineligible',
                checkedAt: now,
                reason: 'invalidBinding',
            };
            continue;
        }

        let dataEncryptionKey: string;
        try {
            dataEncryptionKey = encodeBase64(dataKey, 'base64');
        } finally {
            dataKey.fill(0);
        }
        const candidate: PreflightCandidate = {
            sessionId: session.id,
            fingerprint,
            checkedAt: now,
            input: {
                sessionId: session.id,
                directory,
                threadId,
                dataEncryptionKey,
            },
        };
        const machineCandidates = candidatesByMachine.get(machineId) ?? [];
        machineCandidates.push(candidate);
        candidatesByMachine.set(machineId, machineCandidates);
        immediateEntries[session.id] = {
            fingerprint,
            state: 'checking',
            checkedAt: now,
        };
    }

    if (Object.keys(immediateEntries).length > 0) {
        storage.getState().applyResumeEligibility(immediateEntries);
    }

    const launchedPromises: Promise<void>[] = [];
    for (const [machineId, candidates] of candidatesByMachine) {
        for (let offset = 0; offset < candidates.length; offset += 25) {
            const batch = candidates.slice(offset, offset + 25);
            let pending!: Promise<void>;
            pending = runPreflightBatch(machineId, batch).finally(() => {
                for (const candidate of batch) {
                    const current = inFlightBySessionId.get(candidate.sessionId);
                    if (current?.promise === pending) {
                        inFlightBySessionId.delete(candidate.sessionId);
                    }
                }
            });
            for (const candidate of batch) {
                inFlightBySessionId.set(candidate.sessionId, {
                    fingerprint: candidate.fingerprint,
                    promise: pending,
                });
            }
            launchedPromises.push(pending);
        }
    }

    await Promise.all([...existingPromises, ...launchedPromises]);
}

export async function ensureResumeEligibilityForSession(options: {
    session: Session;
    machine: Machine | null | undefined;
    machinesLoaded: boolean;
    force?: boolean;
}): Promise<ResumeEligibilityEntry | null> {
    await ensureResumeEligibilityForSessions({
        sessions: [options.session],
        machines: options.machine ? [options.machine] : [],
        machinesLoaded: options.machinesLoaded,
        ...(options.force ? { forceSessionIds: new Set([options.session.id]) } : {}),
    });
    const fingerprint = buildResumeEligibilityFingerprint(options.session, options.machine);
    const entry = storage.getState().resumeEligibilityBySessionId[options.session.id];
    return isResumeEligibilityFresh(entry, fingerprint) ? entry : null;
}

export function useResumeEligibilityPreflight(options: {
    sessions: readonly Session[];
    machines: readonly Machine[];
    machinesLoaded: boolean;
}): number {
    const latestOptions = React.useRef(options);
    latestOptions.current = options;
    const signature = React.useMemo(() => {
        const machineById = new Map(options.machines.map((machine) => [machine.id, machine]));
        return JSON.stringify({
            machinesLoaded: options.machinesLoaded,
            sessions: options.sessions
                .filter((session) => !session.active && session.archivedAt === null)
                .map((session) => buildResumeEligibilityFingerprint(
                    session,
                    session.metadata?.machineId
                        ? machineById.get(session.metadata.machineId)
                        : undefined,
                )),
        });
    }, [options.machines, options.machinesLoaded, options.sessions]);
    const [now, setNow] = React.useState(() => Date.now());
    const [refreshGeneration, setRefreshGeneration] = React.useState(0);

    React.useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        void ensureResumeEligibilityForSessions(latestOptions.current).then(() => {
            if (cancelled) return;

            const checkedNow = Date.now();
            setNow(checkedNow);
            const currentOptions = latestOptions.current;
            const machineById = new Map(currentOptions.machines.map((machine) => [machine.id, machine]));
            const currentEntries = storage.getState().resumeEligibilityBySessionId;
            const matchingEntries = currentOptions.sessions.flatMap((session) => {
                if (session.active || session.archivedAt !== null) return [];
                const machine = session.metadata?.machineId
                    ? machineById.get(session.metadata.machineId)
                    : undefined;
                const fingerprint = buildResumeEligibilityFingerprint(session, machine);
                const entry = currentEntries[session.id];
                return entry?.fingerprint === fingerprint ? [entry] : [];
            });
            const refreshDelay = resolveResumeEligibilityRefreshDelay(matchingEntries, checkedNow);
            if (refreshDelay === null) return;
            timer = setTimeout(() => {
                setNow(Date.now());
                setRefreshGeneration((current) => current + 1);
            }, refreshDelay);
        }).catch(() => {
            if (cancelled) return;
            const failedAt = Date.now();
            setNow(failedAt);
            timer = setTimeout(() => {
                setNow(Date.now());
                setRefreshGeneration((current) => current + 1);
            }, RESUME_ELIGIBILITY_TTL_MS);
        });
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [refreshGeneration, signature]);

    return now;
}

function resolveLocalEligibility(options: {
    session: Session;
    machine: Machine | undefined;
    machinesLoaded: boolean;
    machineRecord: Record<string, Machine>;
    fingerprint: string;
    checkedAt: number;
}): ResumeEligibilityEntry | null {
    const { session, machine, fingerprint, checkedAt } = options;
    if (
        session.metadata?.codexReadOnly === true
        || session.metadata?.flavor !== 'codex'
        || session.metadata?.codexSyncVersion !== 4
        || !session.metadata.machineId
        || !session.metadata.path?.trim()
        || !session.metadata.codexThreadId?.trim()
    ) {
        return ineligibleEntry(fingerprint, checkedAt, 'invalidBinding');
    }
    if (
        isSessionMachineDeleted(
            session,
            options.machineRecord,
            options.machinesLoaded,
        )
    ) {
        return ineligibleEntry(fingerprint, checkedAt, 'machineDeleted');
    }
    if (!machine) {
        return options.machinesLoaded
            ? ineligibleEntry(fingerprint, checkedAt, 'machineDeleted')
            : checkingEntry(fingerprint, checkedAt, 'preflightUnavailable');
    }
    if (!isMachineOnline(machine)) {
        return checkingEntry(fingerprint, checkedAt, 'machineOffline');
    }
    if (
        machine.metadata?.resumeSupport?.rpcAvailable !== true
        || machine.metadata.resumeSupport.preflightRpcAvailable !== true
    ) {
        return checkingEntry(fingerprint, checkedAt, 'preflightUnavailable');
    }
    return null;
}

async function runPreflightBatch(
    machineId: string,
    candidates: PreflightCandidate[],
): Promise<void> {
    let results: PreflightResumeSessionResult[];
    try {
        const response = await machinePreflightResumeSessions({
            machineId,
            sessions: candidates.map((candidate) => candidate.input),
        });
        results = response.results;
    } catch {
        applyBatchEntries(candidates, () => ({
            state: 'checking',
            reason: 'providerUnavailable',
        }));
        return;
    }

    let shouldRefreshSessions = false;
    applyBatchEntries(candidates, (candidate) => {
        const result = results.find((item) => item.sessionId === candidate.sessionId);
        if (!result) {
            return { state: 'checking', reason: 'providerUnavailable' };
        }
        switch (result.type) {
            case 'eligible':
                return { state: 'eligible' };
            case 'ineligible':
                return { state: 'ineligible', reason: result.reason };
            case 'pending':
                return { state: 'checking', reason: result.reason };
            case 'alreadyActive':
                shouldRefreshSessions = true;
                return { state: 'checking', reason: 'alreadyActive' };
        }
    });
    if (shouldRefreshSessions) {
        await sync.refreshSessions().catch(() => undefined);
    }
}

function applyBatchEntries(
    candidates: PreflightCandidate[],
    resolveEntry: (candidate: PreflightCandidate) => {
        state: ResumeEligibilityEntry['state'];
        reason?: ResumeEligibilityReason;
    },
): void {
    const currentEntries = storage.getState().resumeEligibilityBySessionId;
    const entries: Record<string, ResumeEligibilityEntry> = {};
    for (const candidate of candidates) {
        if (currentEntries[candidate.sessionId]?.fingerprint !== candidate.fingerprint) continue;
        const resolved = resolveEntry(candidate);
        entries[candidate.sessionId] = {
            fingerprint: candidate.fingerprint,
            state: resolved.state,
            checkedAt: candidate.checkedAt,
            ...(resolved.reason ? { reason: resolved.reason } : {}),
        };
    }
    if (Object.keys(entries).length > 0) {
        storage.getState().applyResumeEligibility(entries);
    }
}

function checkingEntry(
    fingerprint: string,
    checkedAt: number,
    reason: ResumeEligibilityReason,
): ResumeEligibilityEntry {
    return { fingerprint, state: 'checking', checkedAt, reason };
}

function ineligibleEntry(
    fingerprint: string,
    checkedAt: number,
    reason: ResumeEligibilityReason,
): ResumeEligibilityEntry {
    return { fingerprint, state: 'ineligible', checkedAt, reason };
}
