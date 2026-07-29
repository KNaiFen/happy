const MIN_MACHINE_REGISTRATION_RETRY_MS = 1_000;
const MAX_MACHINE_REGISTRATION_RETRY_MS = 15_000;

export function machineRegistrationRetryDelay(failureCount: number): number {
    const boundedFailureCount = Math.max(0, Math.min(4, Math.trunc(failureCount)));
    return Math.min(
        MIN_MACHINE_REGISTRATION_RETRY_MS * (2 ** boundedFailureCount),
        MAX_MACHINE_REGISTRATION_RETRY_MS,
    );
}
