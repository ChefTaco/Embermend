-- Historical facts are append only. Mutable product projections have separate tables.
CREATE FUNCTION embermend_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Embermend historical records are append only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON "Audit" FOR EACH ROW EXECUTE FUNCTION embermend_reject_history_mutation();
CREATE TRIGGER evidence_append_only BEFORE UPDATE OR DELETE ON "Evidence" FOR EACH ROW EXECUTE FUNCTION embermend_reject_history_mutation();
CREATE TRIGGER observation_append_only BEFORE UPDATE OR DELETE ON "Observation" FOR EACH ROW EXECUTE FUNCTION embermend_reject_history_mutation();
CREATE TRIGGER revision_append_only BEFORE UPDATE OR DELETE ON "PlanRevision" FOR EACH ROW EXECUTE FUNCTION embermend_reject_history_mutation();
CREATE TRIGGER verification_append_only BEFORE UPDATE OR DELETE ON "Verification" FOR EACH ROW EXECUTE FUNCTION embermend_reject_history_mutation();
CREATE TRIGGER publication_append_only BEFORE UPDATE OR DELETE ON "Publication" FOR EACH ROW EXECUTE FUNCTION embermend_reject_history_mutation();
