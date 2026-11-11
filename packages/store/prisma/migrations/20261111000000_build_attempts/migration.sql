-- Provider reruns have distinct evidence and cannot replace an earlier attempt.
ALTER TABLE "Build" ADD COLUMN "providerAttempt" INTEGER NOT NULL DEFAULT 1;
DROP INDEX "Build_repositoryId_providerRunId_key";
CREATE UNIQUE INDEX "Build_repositoryId_providerRunId_providerAttempt_key"
  ON "Build"("repositoryId", "providerRunId", "providerAttempt");
