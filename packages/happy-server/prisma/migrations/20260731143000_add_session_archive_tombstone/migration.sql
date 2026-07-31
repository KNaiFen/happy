-- Persist an explicit archive tombstone so delayed heartbeats cannot revive a session.
ALTER TABLE "Session"
ADD COLUMN "archivedAt" TIMESTAMP(3);
