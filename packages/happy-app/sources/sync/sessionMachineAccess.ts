import type { Machine, Session } from './storageTypes';

export function isSessionMachineDeleted(
    session: Pick<Session, 'originMachineId' | 'machineDeletedAt' | 'metadata'>,
    machines: Readonly<Record<string, Machine>>,
    machinesLoaded: boolean,
): boolean {
    if (typeof session.machineDeletedAt === 'number') return true;
    if (!machinesLoaded) return false;
    const machineId = session.originMachineId ?? session.metadata?.machineId;
    return typeof machineId === 'string'
        && machineId.length > 0
        && machines[machineId] === undefined;
}
