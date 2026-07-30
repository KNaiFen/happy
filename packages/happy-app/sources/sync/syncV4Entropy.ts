import { getRandomBytes, randomUUID } from 'expo-crypto';

export function generateSyncV4MutationId(): string {
    return randomUUID();
}

export function generateSyncV4TraceId(): string {
    return Array.from(
        getRandomBytes(16),
        (value) => value.toString(16).padStart(2, '0'),
    ).join('');
}

export const nativeSyncV4Entropy = {
    generateMutationId: generateSyncV4MutationId,
    generateTraceId: generateSyncV4TraceId,
};
