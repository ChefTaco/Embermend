-- The audit export pages every installation oldest first by (createdAt, id).
-- New rows record the authenticated actor kind; earlier rows keep NULL.
ALTER TABLE "Audit" ADD COLUMN "actorKind" TEXT;
CREATE INDEX "Audit_createdAt_id_idx" ON "Audit"("createdAt", "id");
