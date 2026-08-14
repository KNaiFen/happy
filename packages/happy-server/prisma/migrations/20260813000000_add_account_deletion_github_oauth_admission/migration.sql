-- CreateTable
CREATE TABLE "AccountDeletionGithubOAuthAdmission" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "callbackStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDeletionGithubOAuthAdmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountDeletionGithubOAuthAdmission_state_idx" ON "AccountDeletionGithubOAuthAdmission"("accountId", "callbackStartedAt", "completedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "AccountDeletionGithubOAuthAdmission" ADD CONSTRAINT "AccountDeletionGithubOAuthAdmission_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
