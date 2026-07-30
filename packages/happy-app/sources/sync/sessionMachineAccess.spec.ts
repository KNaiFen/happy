import { describe, expect, it } from 'vitest';
import { isSessionMachineDeleted } from './sessionMachineAccess';
import type { Machine, Session } from './storageTypes';

const machine = { id: 'machine-1' } as Machine;

function session(
    input: Partial<Pick<Session, 'originMachineId' | 'machineDeletedAt' | 'metadata'>>,
): Pick<Session, 'originMachineId' | 'machineDeletedAt' | 'metadata'> {
    return {
        originMachineId: null,
        machineDeletedAt: null,
        metadata: null,
        ...input,
    };
}

describe('isSessionMachineDeleted', () => {
    it('uses the server tombstone before machine hydration', () => {
        expect(isSessionMachineDeleted(
            session({ machineDeletedAt: 10 }),
            {},
            false,
        )).toBe(true);
    });

    it('does not infer deletion before a successful machine fetch', () => {
        expect(isSessionMachineDeleted(
            session({ metadata: { machineId: 'machine-1' } as Session['metadata'] }),
            {},
            false,
        )).toBe(false);
    });

    it('falls back to encrypted metadata for pre-migration orphan sessions', () => {
        const legacy = session({
            metadata: { machineId: 'machine-1' } as Session['metadata'],
        });
        expect(isSessionMachineDeleted(legacy, {}, true)).toBe(true);
        expect(isSessionMachineDeleted(
            legacy,
            { 'machine-1': machine },
            true,
        )).toBe(false);
    });

    it('prefers the persisted origin machine over stale metadata', () => {
        expect(isSessionMachineDeleted(
            session({
                originMachineId: 'machine-2',
                metadata: { machineId: 'machine-1' } as Session['metadata'],
            }),
            { 'machine-1': machine },
            true,
        )).toBe(true);
    });
});
