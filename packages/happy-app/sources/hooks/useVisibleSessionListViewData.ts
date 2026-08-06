import * as React from 'react';
import {
    SessionListViewItem,
    useAllMachines,
    useAllSessions,
    useMachinesLoaded,
    useResumeEligibilityBySessionId,
    useSessionListViewData,
    useSetting,
} from '@/sync/storage';
import { buildVisibleSessionListViewData } from './sessionListVisibility';
import {
    buildResumeEligibilityFingerprint,
    isResumeEligibilityFresh,
    useResumeEligibilityPreflight,
} from '@/sync/resumeEligibility';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideArchivedSessions = useSetting('hideArchivedSessions');
    const sessions = useAllSessions();
    const machines = useAllMachines({ includeOffline: true });
    const machinesLoaded = useMachinesLoaded();
    const resumeEligibilityBySessionId = useResumeEligibilityBySessionId();
    const now = useResumeEligibilityPreflight({ sessions, machines, machinesLoaded });
    const currentResumeEligibility = React.useMemo(() => {
        const machineById = new Map(machines.map((machine) => [machine.id, machine]));
        return Object.fromEntries(sessions.flatMap((session) => {
            const machine = session.metadata?.machineId
                ? machineById.get(session.metadata.machineId)
                : undefined;
            const fingerprint = buildResumeEligibilityFingerprint(session, machine);
            const entry = resumeEligibilityBySessionId[session.id];
            return isResumeEligibilityFresh(entry, fingerprint, now)
                ? [[session.id, entry] as const]
                : [];
        }));
    }, [machines, now, resumeEligibilityBySessionId, sessions]);

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        return buildVisibleSessionListViewData(
            data,
            hideArchivedSessions,
            currentResumeEligibility,
        );
    }, [currentResumeEligibility, data, hideArchivedSessions]);
}
