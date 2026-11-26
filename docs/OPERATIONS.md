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

Keep the API and worker's protected grant configuration identical. Grants come from
exactly one of `EMBERMEND_IDENTITY_GRANTS` (a JSON array fixed at startup) or
`EMBERMEND_IDENTITY_GRANTS_FILE` (a path to the same JSON, mounted read-only into both
processes). A grants file is checked for changes at most every two seconds, so onboarding,
narrowing or revoking a subject takes effect within seconds without a restart (log
`grants.reloaded`). Replace it atomically (write a temporary file, then rename it). The file
must be valid at startup; a later invalid version is logged as `grants.reload_failed` and
the last valid grants stay in force until a valid file replaces it. With the environment
variable, apply changes through the owning installer and verify the effective environments;
restarting an already created container does not reload its Compose environment file.
The worker checks each queued job and scheduled delivery against the grants in force at
that moment before acting on it. A job whose creator no longer has exactly one grant
of the same kind covering the job's scope fails with `ACTOR_GRANT_REVOKED`,
`ACTOR_KIND_CHANGED` or `ACTOR_SCOPE_REVOKED` (audit `job.authority-revoked`); a
scheduled occurrence is blocked (audit `schedule.blocked` with the same reason) until
an operator re-creates the schedule. Narrowed permissions are intersected with the
grant (audit `job.authority-narrowed` or `schedule.authority-narrowed`), so work
continues only while it still holds the permission its normal admission requires.
Production mutation policies stay disabled until explicitly authorized.

## Worker concurrency and shutdown

`EMBERMEND_WORKER_CONCURRENCY` (1 to 8, default 1) sets how many jobs one worker runs at
once, so a campaign waiting on receipts no longer holds up assessments. Lanes claim with
`FOR UPDATE SKIP LOCKED`; maintenance (exception expiry, schedule enqueueing) and schedule
delivery run in their own loop every second. Each lane can hold a database connection.

On the first SIGTERM or SIGINT the worker stops claiming (`worker.draining`). A running
assessment or receipt wait continues for up to `EMBERMEND_WORKER_DRAIN_SECONDS` (default 8);
a campaign stops at its next action boundary, where nothing of it is in flight, and returns
to the queue to resume later with its original authority and deadline. Whatever is still
running when the drain time ends, or at a second signal, is interrupted as before and
becomes `unknown` for reconciliation. Docker and Compose kill a container 10 seconds after
SIGTERM by default: raise `stop_grace_period` above the drain time before raising it.

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
