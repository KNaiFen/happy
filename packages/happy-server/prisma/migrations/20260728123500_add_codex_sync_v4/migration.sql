-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "syncV4Seq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SessionEntityV4" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "producerId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "updatedSeq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionEntityV4_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionMutationV4" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "producerId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prunedAt" TIMESTAMP(3),

    CONSTRAINT "SessionMutationV4_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionEntityV4_sessionId_entityId_key" ON "SessionEntityV4"("sessionId", "entityId");

-- CreateIndex
CREATE INDEX "SessionEntityV4_sessionId_updatedSeq_idx" ON "SessionEntityV4"("sessionId", "updatedSeq");

-- CreateIndex
CREATE UNIQUE INDEX "SessionMutationV4_sessionId_mutationId_key" ON "SessionMutationV4"("sessionId", "mutationId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionMutationV4_sessionId_seq_key" ON "SessionMutationV4"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "SessionMutationV4_sessionId_createdAt_idx" ON "SessionMutationV4"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "SessionMutationV4_sessionId_prunedAt_seq_idx" ON "SessionMutationV4"("sessionId", "prunedAt", "seq");

-- AddForeignKey
ALTER TABLE "SessionEntityV4" ADD CONSTRAINT "SessionEntityV4_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionMutationV4" ADD CONSTRAINT "SessionMutationV4_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
