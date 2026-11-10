CREATE TABLE "Preparation" (
  "id" TEXT PRIMARY KEY NOT NULL, "installationId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL, "applicationId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL, "requestDigest" TEXT NOT NULL,
  "data" JSONB NOT NULL, "result" JSONB
);
CREATE UNIQUE INDEX "Preparation_jobId_key" ON "Preparation"("jobId");
CREATE TABLE "ProviderEffect" (
  "id" TEXT PRIMARY KEY NOT NULL, "planId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL, "actionId" TEXT NOT NULL,
  "phase" TEXT NOT NULL, "requestDigest" TEXT NOT NULL,
  "state" TEXT NOT NULL, "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ProviderEffect_planId_revision_actionId_phase_key" ON "ProviderEffect"("planId", "revision", "actionId", "phase");
