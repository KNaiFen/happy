export type EmptyMainScreenState = 'loading' | 'start-session' | 'pair-machine';

export function resolveEmptyMainScreenState(
    machinesLoaded: boolean,
    machineCount: number,
): EmptyMainScreenState {
    if (machineCount > 0) return 'start-session';
    return machinesLoaded ? 'pair-machine' : 'loading';
}
