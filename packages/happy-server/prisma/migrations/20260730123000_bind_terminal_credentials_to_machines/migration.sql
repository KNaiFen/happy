-- Add terminal credential lifecycle state without invalidating existing tokens.
ALTER TABLE "TerminalAuthRequest"
ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "revokedAt" TIMESTAMP(3);

-- Preserve deleted devices as tombstones and bind one terminal credential to one machine.
ALTER TABLE "Machine"
ADD COLUMN "credentialId" TEXT,
ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Persist the machine that created each session.
ALTER TABLE "Session"
ADD COLUMN "originMachineId" TEXT;

CREATE UNIQUE INDEX "Machine_credentialId_key" ON "Machine"("credentialId");
CREATE INDEX "Machine_accountId_deletedAt_idx" ON "Machine"("accountId", "deletedAt");
CREATE INDEX "Session_originMachineId_idx" ON "Session"("originMachineId");

ALTER TABLE "Machine"
ADD CONSTRAINT "Machine_credentialId_fkey"
FOREIGN KEY ("credentialId") REFERENCES "TerminalAuthRequest"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Session"
ADD CONSTRAINT "Session_originMachineId_fkey"
FOREIGN KEY ("originMachineId") REFERENCES "Machine"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill only when historical AccessKey rows identify exactly one origin machine.
WITH "UniqueSessionMachine" AS (
    SELECT
        "sessionId",
        MIN("machineId") AS "machineId"
    FROM "AccessKey"
    GROUP BY "sessionId"
    HAVING COUNT(DISTINCT "machineId") = 1
)
UPDATE "Session" AS "session"
SET "originMachineId" = "candidate"."machineId"
FROM "UniqueSessionMachine" AS "candidate"
JOIN "Machine" AS "machine"
    ON "machine"."id" = "candidate"."machineId"
WHERE "session"."id" = "candidate"."sessionId"
  AND "session"."accountId" = "machine"."accountId"
  AND "session"."originMachineId" IS NULL;
