type ArtifactLifecycleState = {
    updateSeq: number;
    revision: number;
    deleted: boolean;
};

export type ArtifactLifecycleSnapshotState = {
    updateSeq: number;
    deleted: boolean;
};

export type ArtifactSnapshotReconciliation = {
    acceptedPresentIds: Set<string>;
    deletedArtifactIds: string[];
};

export class ArtifactLifecycleFence {
    private revision = 0;
    private readonly states = new Map<string, ArtifactLifecycleState>();

    capture(): number {
        return this.revision;
    }

    canApplyFetch(artifactId: string, capturedRevision: number): boolean {
        const state = this.states.get(artifactId);
        return !state?.deleted && (!state || state.revision <= capturedRevision);
    }

    commitFetch<T>(
        artifactId: string,
        capturedRevision: number,
        updateSeq: number,
        apply: () => T,
    ): T | null {
        if (!this.canApplyFetch(artifactId, capturedRevision)) return null;
        const state = this.states.get(artifactId);
        if (state && updateSeq < state.updateSeq) return null;

        const result = apply();
        if (!state || updateSeq > state.updateSeq) {
            this.states.set(artifactId, {
                updateSeq,
                revision: ++this.revision,
                deleted: false,
            });
        }
        return result;
    }

    isDeleted(artifactId: string): boolean {
        return this.states.get(artifactId)?.deleted === true;
    }

    getState(artifactId: string): ArtifactLifecycleSnapshotState | undefined {
        const state = this.states.get(artifactId);
        return state ? { updateSeq: state.updateSeq, deleted: state.deleted } : undefined;
    }

    /** A snapshot at H may only affect state that has not advanced past H. */
    canApplySnapshot(artifactId: string, highWatermark: number): boolean {
        return (this.states.get(artifactId)?.updateSeq ?? 0) <= highWatermark;
    }

    recordSnapshotPresent(artifactId: string, updateSeq: number): boolean {
        const state = this.states.get(artifactId);
        if (state && updateSeq < state.updateSeq) return false;
        if (state?.deleted && updateSeq <= state.updateSeq) return false;
        if (state && state.updateSeq === updateSeq) return true;
        this.states.set(artifactId, {
            updateSeq,
            revision: ++this.revision,
            deleted: false,
        });
        return true;
    }

    recordSnapshotDelete(artifactId: string, highWatermark: number): boolean {
        const state = this.states.get(artifactId);
        if (state && state.updateSeq > highWatermark) return false;
        if (state?.deleted && state.updateSeq >= highWatermark) return true;
        this.states.set(artifactId, {
            updateSeq: highWatermark,
            revision: ++this.revision,
            deleted: true,
        });
        return true;
    }

    reconcileSnapshot(
        presentArtifacts: ReadonlyArray<{ id: string; updateSeq: number }>,
        localArtifactIds: Iterable<string>,
        highWatermark: number,
    ): ArtifactSnapshotReconciliation {
        if (presentArtifacts.some((artifact) => artifact.updateSeq > highWatermark)) {
            throw new Error('Artifact snapshot row exceeds its high watermark');
        }
        const remoteIds = new Set(presentArtifacts.map((artifact) => artifact.id));
        const acceptedPresentIds = new Set<string>();
        for (const artifact of presentArtifacts) {
            if (this.canApplySnapshot(artifact.id, highWatermark)
                && this.recordSnapshotPresent(artifact.id, artifact.updateSeq)) {
                acceptedPresentIds.add(artifact.id);
            }
        }
        const deletedArtifactIds: string[] = [];
        for (const artifactId of new Set(localArtifactIds)) {
            if (!remoteIds.has(artifactId) && this.recordSnapshotDelete(artifactId, highWatermark)) {
                deletedArtifactIds.push(artifactId);
            }
        }
        return { acceptedPresentIds, deletedArtifactIds };
    }

    recordNew(artifactId: string, updateSeq: number): boolean {
        const state = this.states.get(artifactId);
        if (state && updateSeq <= state.updateSeq) return false;
        this.states.set(artifactId, {
            updateSeq,
            revision: ++this.revision,
            deleted: false,
        });
        return true;
    }

    recordUpdate(artifactId: string, updateSeq: number): boolean {
        const state = this.states.get(artifactId);
        if (state?.deleted || (state && updateSeq <= state.updateSeq)) return false;
        this.states.set(artifactId, {
            updateSeq,
            revision: ++this.revision,
            deleted: false,
        });
        return true;
    }

    recordDelete(artifactId: string, updateSeq: number): boolean {
        const state = this.states.get(artifactId);
        if (state && updateSeq < state.updateSeq) return false;
        if (state?.deleted && updateSeq === state.updateSeq) return true;
        this.states.set(artifactId, {
            updateSeq,
            revision: ++this.revision,
            deleted: true,
        });
        return true;
    }

    clear(): void {
        this.states.clear();
        this.revision = 0;
    }
}
