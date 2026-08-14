-- Persist the account-global sequence at which each artifact row was last
-- created or changed, plus an artifact-only revision that invalidates cursor
-- snapshots without coupling them to unrelated account mutations.
ALTER TABLE "Account" ADD COLUMN "artifactRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Artifact" ADD COLUMN "updateSeq" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Artifact_accountId_updateSeq_id_idx"
    ON "Artifact"("accountId", "updateSeq", "id");
