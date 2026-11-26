-- List endpoints filter by scope and page in the database (opaque cursors).
-- Plans order the recommendations timeline by their last change; existing plans start
-- from the creation time of their newest revision.
ALTER TABLE "Plan" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "Plan" AS p SET "updatedAt" = r.latest
  FROM (SELECT "planId", MAX("createdAt") AS latest FROM "PlanRevision" GROUP BY "planId") AS r
  WHERE r."planId" = p.id;
CREATE INDEX "Plan_installationId_updatedAt_id_idx" ON "Plan"("installationId", "updatedAt" DESC, "id" DESC);
CREATE INDEX "Finding_installationId_updatedAt_id_idx" ON "Finding"("installationId", "updatedAt" DESC, "id" DESC);
CREATE INDEX "Entity_installationId_id_idx" ON "Entity"("installationId", "id");
CREATE INDEX "Exception_installationId_id_idx" ON "Exception"("installationId", "id");
CREATE INDEX "ProfileAssignment_installationId_id_idx" ON "ProfileAssignment"("installationId", "id");
CREATE INDEX "Build_installationId_id_idx" ON "Build"("installationId", "id");
-- The timeline reads each plan's campaign jobs by payload->>'planId'. Not expressible in the
-- Prisma schema, which notes it on the Job model.
CREATE INDEX "Job_campaign_planId_idx" ON "Job" ((payload->>'planId')) WHERE kind = 'campaign';
