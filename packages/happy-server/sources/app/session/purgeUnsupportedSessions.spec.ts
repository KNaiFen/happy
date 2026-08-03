import { describe, expect, it, vi } from 'vitest';
import {
    PRESERVED_SESSION_TAG_PREFIXES,
    purgeUnsupportedSessions,
    type UnsupportedSessionPurgeDependencies,
} from './purgeUnsupportedSessions';

describe('purgeUnsupportedSessions', () => {
    it('publishes the exact Codex V4 tag allowlist', () => {
        expect(PRESERVED_SESSION_TAG_PREFIXES).toEqual([
            'codex-gateway-root-v1-',
            'codex-child-v4-',
        ]);
    });

    it('deletes attachments before each unsupported session record', async () => {
        const remaining = ['legacy-1', 'legacy-2'];
        const calls: string[] = [];
        const dependencies: UnsupportedSessionPurgeDependencies = {
            listBatch: vi.fn(async (limit) => remaining.slice(0, limit).map((id) => ({ id }))),
            deleteAttachments: vi.fn(async (id) => {
                calls.push(`attachments:${id}`);
            }),
            deleteRecord: vi.fn(async (id) => {
                calls.push(`record:${id}`);
                remaining.splice(remaining.indexOf(id), 1);
                return true;
            }),
        };

        await expect(purgeUnsupportedSessions(dependencies, 1)).resolves.toBe(2);
        expect(calls).toEqual([
            'attachments:legacy-1',
            'record:legacy-1',
            'attachments:legacy-2',
            'record:legacy-2',
        ]);
    });

    it('does not delete a record when attachment cleanup fails', async () => {
        const deleteRecord = vi.fn(async () => true);
        const dependencies: UnsupportedSessionPurgeDependencies = {
            listBatch: vi.fn(async () => [{ id: 'legacy-1' }]),
            deleteAttachments: vi.fn(async () => {
                throw new Error('storage unavailable');
            }),
            deleteRecord,
        };

        await expect(purgeUnsupportedSessions(dependencies)).rejects.toThrow('storage unavailable');
        expect(deleteRecord).not.toHaveBeenCalled();
    });
});
