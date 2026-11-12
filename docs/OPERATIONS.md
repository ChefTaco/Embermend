# Operations and runtime access

Run service checks and record the compatible release, assessed scope and coverage.
A healthy process does not establish an assessed or secure target. The authenticated
`/api/v1/readiness` operation distinguishes availability, fresh enrolled inventory
targets and dependency blockers; `/health/compatibility` identifies the runtime and
required protocol. Hive ingress adds the `/api/embermend` prefix.

## Starting permissions

An existing operator can use `read`, `evidence` and `assess` for inventory,
assessment, retained results and ordinary evidence in explicitly named scopes.
Restricted evidence needs `evidence-restricted`. Profile publication requires an
operator's `policy` permission during reviewed setup. Remove that temporary
permission afterward. Creating or starting remediation, writing a branch, merge,
artifact publication, deployment, exception acceptance and recovery require their
own permissions and matching authorization. A role name alone grants none of them.

`audit:read` (`embermend:audit:read` on the token) allows the audit export at
`/api/v1/audit/export` and nothing else. Grant it to the Cindertrace collector's
service account, which then reads every installation, and to an operator only
when that operator should read its own installation's audit trail.

Keep the API and worker's protected grant configuration identical. Apply changes
through the owning installer and verify their effective environments; restarting
an already created container does not reload its Compose environment file.
Production mutation policies stay disabled until explicitly authorized.

## Operational observations

Track queue age and expired/unknown work, assessment freshness and coverage,
verification backlog, unpublished recommendations and publication errors, held
executions, and dependency readiness. Preserve original job and operation IDs when
investigating any failure. Publication errors block dispatch; an empty findings
list does not establish coverage.

A database owner can collect these metadata-only observations using existing
maintenance authentication and a read-only transaction. They are administrative
queries over that installation, not a substitute for scoped user API access:

```sql
BEGIN READ ONLY;
SELECT status, count(*),
  max(EXTRACT(EPOCH FROM (now() - "createdAt"))) AS oldest_age_seconds
FROM "Job" WHERE status IN ('queued', 'running', 'unknown') GROUP BY status;
SELECT kind, payload->>'profileId' AS profile,
  max("updatedAt") AS latest_completed_assessment
FROM "Job" WHERE status='completed'
  AND kind IN ('assessment', 'vulnerabilities', 'scan')
GROUP BY kind, payload->>'profileId';
SELECT state, count(*) FROM "Execution"
WHERE state IN ('queued', 'running', 'unknown')
  AND COALESCE(receipt->'ownershipReleased', 'false'::jsonb) <> 'true'::jsonb
GROUP BY state;
SELECT count(*) AS occurrences_needing_review_or_verification
FROM "Occurrence" WHERE COALESCE(data->>'sourceState', 'unknown') NOT IN ('verified-fixed', 'not-applicable')
  OR COALESCE(data->>'runtimeState', 'unknown') NOT IN ('verified-resolved', 'not-applicable');
SELECT count(*) AS unpublished_current_revisions FROM "Plan" p
WHERE NOT EXISTS (SELECT 1 FROM "Publication" u
  WHERE u."planId"=p.id AND u.revision=p."currentRevision");
SELECT status, count(*) FROM "Outbox" GROUP BY status;
COMMIT;
```

These counters do not certify security closure. Check each assessment's recorded
coverage and each occurrence's independent source/runtime verification. Inspect
redacted service/ingress error logs for failed publication requests; a pending
publication can also be an explanation that has not yet been requested. Retain
failure evidence and the original durable state before recovery. Never reset an
unknown operation to queued or infer completion from a lost connection.

For offline Magnus recovery maintenance, preload the same protected service
environment at process start, using Node's `--env-file` option when invoking its
installed recovery module directly. Node identity and review-key configuration
must be present before imports bind them. Follow Magnus's stopped-agent and
exact-record review requirements; never move those keys into Embermend.

## Proposal for a future unattended identity

Existing operator authentication is sufficient for the reviewed manual setup and
acceptance. An unattended coordinator or API monitor needs token renewal outside
an interactive browser session. That is the concrete reason to add a runtime
identity when that deployment is requested; an administrator role is not a reason
to replace an otherwise sufficient credential.

1. Create one Oathweave machine client for the `embermend` resource audience using
   the existing administrator's authenticated setup path. Initially allow only
   `embermend:read`, `embermend:evidence` and `embermend:assess`, for tokens with a
   maximum lifetime of 15 minutes. A monitoring-only client needs just `read`.
2. Add an Embermend grant for that exact client subject, kind `coordinator` for
   coordination or `integration` for observation, and the reviewed installation,
   application IDs and target IDs. Match the same permission subset in both
   products. No wildcard or approval/policy/recovery permission is needed.
3. Keep the client secret in a service-owned mode-0600 protected environment or
   secret reference outside repository execution. Use the existing resource-token
   provider for renewal. Never copy an operator's browser cookies or CLI credential
   store into API/worker or repository images.
4. Validate in-scope reads and assessment, out-of-scope refusal, token expiry and
   revocation behavior. Coordinator approval, policy changes, evidence ingestion,
   exception acceptance and recovery must remain refused. Enable additional
   preparation/proposal tools only through a separate reviewed grant.

This proposal creates no identity and grants no production automation. GitHub
provider access is separate; its actual operation permissions and optional
unattended App proposal are documented in [provider authorization](GITHUB_PROVIDER_AUTH.md).
