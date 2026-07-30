export type EmptyMainScreenState = 'loading' | 'start-session' | 'pair-machine';

export function resolveEmptyMainScreenState(
    machinesLoaded: boolean,
    machineCount: number,
): EmptyMainScreenState {
    if (!machinesLoaded) return 'loading';
    return machineCount > 0 ? 'start-session' : 'pair-machine';
}
