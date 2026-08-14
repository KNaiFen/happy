-- AlterTable
ALTER TABLE "Account" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AccountDeletionChallenge" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDeletionChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountDeletionRequest" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalSweepAfter" TIMESTAMP(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "lastAttemptedAt" TIMESTAMP(3),

    CONSTRAINT "AccountDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountDeletionChallenge_accountId_expiresAt_idx" ON "AccountDeletionChallenge"("accountId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletionRequest_accountId_key" ON "AccountDeletionRequest"("accountId");

-- CreateIndex
CREATE INDEX "AccountDeletionRequest_leaseExpiresAt_idx" ON "AccountDeletionRequest"("leaseExpiresAt");
CREATE INDEX "AccountDeletionRequest_lastAttemptedAt_idx" ON "AccountDeletionRequest"("lastAttemptedAt");

-- CreateTable
CREATE TABLE "AccountDeletionUploadOperation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDeletionUploadOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountDeletionUploadOperation_accountId_completedAt_idx" ON "AccountDeletionUploadOperation"("accountId", "completedAt");

-- AddForeignKey
ALTER TABLE "AccountDeletionUploadOperation" ADD CONSTRAINT "AccountDeletionUploadOperation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AccountDeletionVoiceAdmission" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "credentialIssuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDeletionVoiceAdmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountDeletionVoiceAdmission_accountId_state_idx" ON "AccountDeletionVoiceAdmission"("accountId", "completedAt", "credentialIssuedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "AccountDeletionVoiceAdmission" ADD CONSTRAINT "AccountDeletionVoiceAdmission_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountDeletionChallenge" ADD CONSTRAINT "AccountDeletionChallenge_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
