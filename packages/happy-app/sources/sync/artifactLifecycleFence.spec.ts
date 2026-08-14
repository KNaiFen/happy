import { describe, expect, it, vi } from 'vitest';
import { ArtifactLifecycleFence } from './artifactLifecycleFence';

describe('ArtifactLifecycleFence', () => {
    it('blocks a deferred fetch continuation when deletion wins during its await', async () => {
        const fence = new ArtifactLifecycleFence();
        const fetchRevision = fence.capture();
        let releaseFetch!: () => void;
        const fetch = new Promise<void>((resolve) => {
            releaseFetch = resolve;
        });
        const apply = async () => {
            await fetch;
            return fence.commitFetch('artifact-1', fetchRevision, 10, () => 'applied');
        };
        const continuation = apply();

        expect(fence.recordDelete('artifact-1', 20)).toBe(true);
        releaseFetch();

        await expect(continuation).resolves.toBeNull();
    });

    it('runs the apply callback only while the captured revision is current', () => {
        const fence = new ArtifactLifecycleFence();
        const apply = () => 'applied';

        expect(fence.commitFetch('artifact-1', fence.capture(), 1, apply)).toBe('applied');
        const staleRevision = fence.capture();
        fence.recordDelete('artifact-1', 2);
        expect(fence.commitFetch('artifact-1', staleRevision, 1, apply)).toBeNull();
    });

    it('records an authoritative fetch sequence before accepting later lifecycle events', () => {
        const fence = new ArtifactLifecycleFence();
        expect(fence.recordUpdate('artifact-1', 10)).toBe(true);
        const fetchRevision = fence.capture();
        const apply = vi.fn(() => 'fetched');

        expect(fence.commitFetch('artifact-1', fetchRevision, 20, apply)).toBe('fetched');
        expect(fence.getState('artifact-1')).toEqual({ updateSeq: 20, deleted: false });
        expect(fence.recordUpdate('artifact-1', 15)).toBe(false);
        expect(fence.recordUpdate('artifact-1', 21)).toBe(true);
    });

    it('does not apply a fetched version older than the known lifecycle sequence', () => {
        const fence = new ArtifactLifecycleFence();
        expect(fence.recordUpdate('artifact-1', 20)).toBe(true);
        const apply = vi.fn(() => 'stale');

        expect(fence.commitFetch('artifact-1', fence.capture(), 15, apply)).toBeNull();
        expect(apply).not.toHaveBeenCalled();
        expect(fence.getState('artifact-1')).toEqual({ updateSeq: 20, deleted: false });
    });

    it('rejects replayed updates and requires a newer new event to cross a tombstone', () => {
        const fence = new ArtifactLifecycleFence();
        expect(fence.recordDelete('artifact-1', 20)).toBe(true);

        expect(fence.recordUpdate('artifact-1', 21)).toBe(false);
        expect(fence.recordNew('artifact-1', 19)).toBe(false);
        expect(fence.recordNew('artifact-1', 20)).toBe(false);
        expect(fence.recordNew('artifact-1', 21)).toBe(true);
        expect(fence.recordUpdate('artifact-1', 21)).toBe(false);
        expect(fence.recordUpdate('artifact-1', 22)).toBe(true);
    });

    it('does not let an old fetch overwrite a later delete and recreation', () => {
        const fence = new ArtifactLifecycleFence();
        const staleFetchRevision = fence.capture();

        expect(fence.recordDelete('artifact-1', 20)).toBe(true);
        expect(fence.recordNew('artifact-1', 21)).toBe(true);

        expect(fence.canApplyFetch('artifact-1', staleFetchRevision)).toBe(false);
        expect(fence.canApplyFetch('artifact-1', fence.capture())).toBe(true);
        expect(fence.recordDelete('artifact-1', 20)).toBe(false);
    });

    it('reconciles a complete snapshot without overwriting lifecycle events newer than its watermark', () => {
        const fence = new ArtifactLifecycleFence();
        fence.recordUpdate('artifact-newer', 31);
        fence.recordNew('artifact-present-newer', 32);

        const result = fence.reconcileSnapshot([
            { id: 'artifact-present', updateSeq: 20 },
            { id: 'artifact-present-newer', updateSeq: 19 },
        ], [
            'artifact-present',
            'artifact-present-newer',
            'artifact-missing',
            'artifact-newer',
        ], 30);

        expect([...result.acceptedPresentIds]).toEqual(['artifact-present']);
        expect(result.deletedArtifactIds).toEqual(['artifact-missing']);
        expect(fence.getState('artifact-missing')).toEqual({ updateSeq: 30, deleted: true });
        expect(fence.getState('artifact-newer')).toEqual({ updateSeq: 31, deleted: false });
        expect(fence.getState('artifact-present-newer')).toEqual({ updateSeq: 32, deleted: false });
    });

    it('lets a newer snapshot row prove recreation after an older tombstone', () => {
        const fence = new ArtifactLifecycleFence();
        fence.recordDelete('artifact-1', 20);

        const stale = fence.reconcileSnapshot(
            [{ id: 'artifact-1', updateSeq: 20 }],
            ['artifact-1'],
            20,
        );
        expect(stale.acceptedPresentIds.size).toBe(0);

        const recreated = fence.reconcileSnapshot(
            [{ id: 'artifact-1', updateSeq: 21 }],
            ['artifact-1'],
            21,
        );
        expect([...recreated.acceptedPresentIds]).toEqual(['artifact-1']);
        expect(fence.getState('artifact-1')).toEqual({ updateSeq: 21, deleted: false });
    });

    it('rejects a row beyond the snapshot watermark before mutating lifecycle state', () => {
        const fence = new ArtifactLifecycleFence();

        expect(() => fence.reconcileSnapshot(
            [{ id: 'artifact-future', updateSeq: 31 }],
            ['artifact-missing'],
            30,
        )).toThrow('exceeds its high watermark');
        expect(fence.getState('artifact-future')).toBeUndefined();
        expect(fence.getState('artifact-missing')).toBeUndefined();
    });
});
