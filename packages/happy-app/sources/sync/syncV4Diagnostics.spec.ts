import { describe, expect, it, vi } from 'vitest';
import {
    AppSyncV4DiagnosticStore,
    appSyncV4DiagnosticStatsAreDegraded,
    readAppSyncV4DiagnosticStatsSafely,
    type SyncV4DiagnosticStorage,
} from './syncV4Diagnostics';

class MemoryStorage implements SyncV4DiagnosticStorage {
    readonly values = new Map<string, string | number>();
    failAfterWrites: number | null = null;
    writes = 0;
    getAllKeysCalls = 0;

    getString(key: string): string | undefined {
        const value = this.values.get(key);
        return typeof value === 'string' ? value : undefined;
    }

    getNumber(key: string): number | undefined {
        const value = this.values.get(key);
        return typeof value === 'number' ? value : undefined;
    }

    set(key: string, value: string | number): void {
        this.writes += 1;
        if (this.failAfterWrites !== null && this.writes > this.failAfterWrites) {
            throw new Error('simulated MMKV crash');
        }
        this.values.set(key, value);
    }

    delete(key: string): void {
        this.values.delete(key);
    }

    getAllKeys(): string[] {
        this.getAllKeysCalls += 1;
        return [...this.values.keys()];
    }
}

function event(index: number) {
    return {
        level: 'debug' as const,
        component: 'app.sync' as const,
        event: 'cursor' as const,
        phase: 'advanced' as const,
        cursor: index,
    };
}

describe('AppSyncV4DiagnosticStore', () => {
    it('persists a bounded ordered ring across instances', () => {
        const storage = new MemoryStorage();
        const first = new AppSyncV4DiagnosticStore(storage, 3, () => 100);
        for (let index = 1; index <= 5; index += 1) first.record(event(index));

        const restored = new AppSyncV4DiagnosticStore(storage, 3, () => 200);
        expect(restored.records().map((record) => record.cursor)).toEqual([3, 4, 5]);
        expect(restored.stats()).toMatchObject({ count: 3, droppedRecords: 2 });
    });

    it('does not expose a slot written before a crashed head commit', () => {
        const storage = new MemoryStorage();
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 3, () => 100);
        diagnostics.record(event(1));
        storage.failAfterWrites = storage.writes + 1;

        expect(() => diagnostics.record(event(2))).not.toThrow();
        expect(diagnostics.stats().writeFailures).toBe(1);
        storage.failAfterWrites = null;
        const restored = new AppSyncV4DiagnosticStore(storage, 3, () => 200);
        expect(restored.records().map((record) => record.cursor)).toEqual([1]);
        restored.record(event(2));
        expect(restored.records().map((record) => record.cursor)).toEqual([1, 2]);
    });

    it('preserves the full committed window when a wrapped head commit fails', () => {
        const storage = new MemoryStorage();
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 3, () => 100);
        diagnostics.record(event(1));
        diagnostics.record(event(2));
        diagnostics.record(event(3));
        storage.failAfterWrites = storage.writes + 1;

        expect(() => diagnostics.record(event(4))).not.toThrow();
        expect(diagnostics.records().map((record) => record.cursor)).toEqual([1, 2, 3]);
        expect(diagnostics.stats().droppedRecords).toBe(0);

        storage.failAfterWrites = null;
        const restored = new AppSyncV4DiagnosticStore(storage, 3, () => 200);
        expect(restored.records().map((record) => record.cursor)).toEqual([1, 2, 3]);
        restored.record(event(4));
        expect(restored.records().map((record) => record.cursor)).toEqual([2, 3, 4]);
        expect(restored.stats().droppedRecords).toBe(1);
    });

    it('skips corrupt slots without changing the committed head', () => {
        const storage = new MemoryStorage();
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 4, () => 100);
        diagnostics.record(event(1));
        diagnostics.record(event(2));
        diagnostics.record(event(3));
        storage.values.set('sync-v4-diagnostics:record:2', '{broken');

        const restored = new AppSyncV4DiagnosticStore(storage, 4, () => 200);
        expect(restored.records().map((record) => record.cursor)).toEqual([1, 3]);
        expect(restored.stats().invalidRecords).toBe(1);
    });

    it('does not promote physical slots when the head commit point is corrupt', () => {
        const storage = new MemoryStorage();
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 4, () => 100);
        diagnostics.record(event(1));
        storage.failAfterWrites = storage.writes + 1;
        diagnostics.record(event(2));
        storage.failAfterWrites = null;
        storage.values.set('sync-v4-diagnostics:head', 'invalid');

        const restored = new AppSyncV4DiagnosticStore(storage, 4, () => 200);
        expect(restored.records()).toEqual([]);
        expect(restored.stats().count).toBe(0);
    });

    it('rejects arbitrary payload fields without persisting plaintext', () => {
        const storage = new MemoryStorage();
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 4, () => 100);
        const secret = 'prompt-reasoning-tool-output-secret';
        diagnostics.record({
            ...event(1),
            payload: { prompt: secret },
            error: new Error(secret),
        } as never);

        expect(diagnostics.records()).toEqual([]);
        expect(diagnostics.stats().invalidRecords).toBe(1);
        expect(JSON.stringify([...storage.values.values()])).not.toContain(secret);
    });

    it('clears only its diagnostic keys', () => {
        const storage = new MemoryStorage();
        storage.values.set('unrelated', 'keep');
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 4, () => 100);
        diagnostics.record(event(1));
        diagnostics.clear();

        expect(diagnostics.records()).toEqual([]);
        expect(storage.values.get('unrelated')).toBe('keep');
    });

    it('resets local sink failure counters after a successful clear', () => {
        const storage = new MemoryStorage();
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 4, () => 100);
        diagnostics.record({ ...event(1), payload: { prompt: 'secret' } } as never);
        storage.failAfterWrites = storage.writes;
        diagnostics.record(event(2));
        storage.failAfterWrites = null;

        expect(diagnostics.stats()).toMatchObject({
            invalidRecords: 1,
            writeFailures: 1,
        });
        diagnostics.clear();

        expect(diagnostics.stats()).toEqual({
            count: 0,
            droppedRecords: 0,
            invalidRecords: 0,
            writeFailures: 0,
            listenerFailures: 0,
        });
    });

    it('notifies subscribers only after committed writes and clear', () => {
        const storage = new MemoryStorage();
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 4, () => 100);
        const listener = vi.fn();
        const unsubscribe = diagnostics.onChange(listener);

        diagnostics.record(event(1));
        storage.failAfterWrites = storage.writes;
        diagnostics.record(event(2));
        storage.failAfterWrites = null;
        diagnostics.clear();
        unsubscribe();
        diagnostics.record(event(3));

        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('keeps startup, steady-state writes, reads, and stats free of full key scans', () => {
        const storage = new MemoryStorage();
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 4, () => 100);

        diagnostics.record(event(1));
        diagnostics.record(event(2));
        diagnostics.stats();

        expect(storage.getAllKeysCalls).toBe(0);
        expect(diagnostics.records().map((record) => record.cursor)).toEqual([1, 2]);
        expect(storage.getAllKeysCalls).toBe(0);
    });

    it('rejects capacities above the declared persistent ring limit', () => {
        const storage = new MemoryStorage();

        expect(() => new AppSyncV4DiagnosticStore(storage, 2_001)).toThrow(
            'between 1 and 2000',
        );
    });

    it('isolates listener failures from persistence and other subscribers', () => {
        const storage = new MemoryStorage();
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 4, () => 100);
        const healthyListener = vi.fn();
        diagnostics.onChange(() => {
            throw new Error('listener prompt secret');
        });
        diagnostics.onChange(healthyListener);

        expect(() => diagnostics.record(event(1))).not.toThrow();

        expect(diagnostics.records().map((record) => record.cursor)).toEqual([1]);
        expect(diagnostics.stats()).toMatchObject({
            writeFailures: 0,
            listenerFailures: 1,
        });
        expect(healthyListener).toHaveBeenCalledOnce();
    });

    it('exports ordered JSONL with a payload-free sink summary', () => {
        const storage = new MemoryStorage();
        const diagnostics = new AppSyncV4DiagnosticStore(storage, 4, () => 100);
        diagnostics.record({
            ...event(1),
            featureEnabled: true,
            transportSecurity: 'insecureHttp',
            softwareVersion: '1.11.10',
            protocolVersion: 4,
        });
        diagnostics.record({
            ...event(2),
            payload: { prompt: 'prompt-secret' },
        } as never);

        const lines = diagnostics.exportJsonl().split('\n').map((line) => JSON.parse(line));

        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({
            featureEnabled: true,
            transportSecurity: 'insecureHttp',
            softwareVersion: '1.11.10',
        });
        expect(lines[1]).toMatchObject({
            component: 'app.registry',
            event: 'lifecycle',
            phase: 'served',
            state: 'degraded',
            count: 1,
            dropped: 0,
            invalid: 1,
            writeFailures: 0,
            listenerFailures: 0,
        });
        expect(diagnostics.exportJsonl()).not.toContain('prompt-secret');
    });

    it('reads only valid sink counters and classifies every loss signal as degraded', () => {
        const healthy = {
            count: 1,
            droppedRecords: 0,
            invalidRecords: 0,
            writeFailures: 0,
            listenerFailures: 0,
        };

        expect(readAppSyncV4DiagnosticStatsSafely(() => healthy)).toEqual(healthy);
        expect(appSyncV4DiagnosticStatsAreDegraded(healthy)).toBe(false);
        expect(appSyncV4DiagnosticStatsAreDegraded({ ...healthy, droppedRecords: 1 })).toBe(true);
        expect(appSyncV4DiagnosticStatsAreDegraded({ ...healthy, invalidRecords: 1 })).toBe(true);
        expect(appSyncV4DiagnosticStatsAreDegraded({ ...healthy, writeFailures: 1 })).toBe(true);
        expect(appSyncV4DiagnosticStatsAreDegraded({ ...healthy, listenerFailures: 1 })).toBe(true);
        expect(readAppSyncV4DiagnosticStatsSafely(() => {
            throw new Error('sink unavailable');
        })).toBeNull();
        expect(readAppSyncV4DiagnosticStatsSafely(() => ({
            ...healthy,
            count: -1,
        }))).toBeNull();
    });
});
