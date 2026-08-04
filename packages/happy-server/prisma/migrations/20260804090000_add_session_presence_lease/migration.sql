-- A live Gateway owns Session presence through an opaque, machine-authenticated lease.
ALTER TABLE "Session"
ADD COLUMN "presenceLeaseId" TEXT;
