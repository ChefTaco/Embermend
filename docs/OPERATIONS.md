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

## Operator authority from Oathweave roles

`EMBERMEND_AUTHORITY_SOURCE` chooses where operator authority comes from. `grants` (the
default, and the behaviour of every earlier release) reads every subject from the grants
setting above. `oathweave` derives each operator's authority from its current Oathweave
roles instead, so onboarding, narrowing and revoking an operator happen in Oathweave
and no operator entry is kept in Embermend. Set the same mode and settings on the API
and the worker.

In `oathweave` mode:

- **Permissions.** Embermend permission `p` is the Oathweave permission `embermend:p`:
  `embermend:read`, `embermend:evidence`, `embermend:evidence-restricted`,
  `embermend:assess`, `embermend:prepare`, `embermend:propose`,
  `embermend:publish-explanation`, `embermend:execute`, `embermend:approve`,
  `embermend:policy`, `embermend:repository-write`, `embermend:merge`,
  `embermend:artifact-publish`, `embermend:deploy`, `embermend:exception`,
  `embermend:recover`, `embermend:ingest` and `embermend:audit:read`. There are no
  wildcards. An operator holds `p` while one of its roles, assigned directly or through a
  group, carries `embermend:p`; a request also needs `embermend:p` on its token, so the
  `hivexui-embermend` browser client's policy (`IAM_BROWSER_CLIENT_POLICIES`) still caps
  what a browser session can use.
- **Scope.** `EMBERMEND_OATHWEAVE_ROLE_SCOPES` (JSON) or
  `EMBERMEND_OATHWEAVE_ROLE_SCOPES_FILE` (a path to the same JSON, re-read on change like the
  grants file: `role_scopes.reloaded`, `role_scopes.reload_failed`) maps Oathweave role names
  to scopes; configure exactly one:

  ```json
  [
    { "role": "embermend-lab", "scope": { "installationId": "lab", "applicationIds": ["web"], "targetIds": ["node-1", "node-2"] } },
    { "role": "embermend-lab-db", "scope": { "installationId": "lab", "applicationIds": ["db"], "targetIds": ["node-3"] } }
  ]
  ```

  An operator's scope is the union of the scopes of its mapped roles (here both roles give
  `web` and `db` on all three nodes). Roles without a mapping add permissions but no scope.
  An operator with no mapped role is refused (`OATHWEAVE_ROLE_SCOPE_REQUIRED`), and one whose
  mapped roles name more than one installation is refused (`OATHWEAVE_ROLE_SCOPE_AMBIGUOUS`):
  an Embermend actor works in one installation, so a person who works on two needs an
  account for each. A union of more than 1000 applications or targets is refused
  (`OATHWEAVE_ROLE_SCOPE_TOO_LARGE`). A disabled or deleted Oathweave account is refused
  (`OATHWEAVE_ACCOUNT_INACTIVE`).
- **Live reads.** Embermend reads the operator's Oathweave account, direct roles and group
  roles on every request and before the worker runs any of its queued jobs or scheduled
  deliveries, through a machine client of the Oathweave admin API, with answers kept for
  `EMBERMEND_OATHWEAVE_DIRECTORY_CACHE_MS` (0 to 60000, default 5000). Removing the role,
  the group membership or the account in Oathweave therefore applies to the next request
  and stops stored work: the job fails with `ACTOR_GRANT_REVOKED` (no mapped role left or
  the account gone) or `ACTOR_SCOPE_REVOKED` (its scope no longer covered), audit
  `job.authority-revoked`, and a scheduled occurrence is blocked; removed permissions are
  intersected away as with grants. When Oathweave cannot be read the API answers
  `503 IDENTITY_PROVIDER_UNAVAILABLE`, and the worker puts the job back in the queue (log
  `worker.authority_unavailable`) or leaves the occurrence for the next pass; an outage
  never revokes anything, and a job's deadline still applies.
- **Service grants.** Coordinators and integrations (the Ardent coordinator, the Cindertrace
  collector) keep their grants in `EMBERMEND_IDENTITY_GRANTS` or
  `EMBERMEND_IDENTITY_GRANTS_FILE`, now optional; an `operator` entry there is refused
  (`OPERATOR_GRANTS_COME_FROM_OATHWEAVE_ROLES`, at startup, or as `grants.reload_failed`).

### Oathweave setup

1. Create the machine client Embermend reads the directory with. In Oathweave's
   environment add it to `IAM_MACHINE_CLIENT_POLICIES`, for example
   `{"embermend-directory":{"audience":"oathweave","permissions":["iam:users:read","iam:groups:read"],"lifetimeSeconds":300,"rotationOwner":"embermend"}}`,
   and its secret (32 to 512 characters) to `IAM_MACHINE_CLIENT_SECRETS`, then restart
   Oathweave. Give it nothing else: these two read permissions let it read accounts,
   roles and group memberships, not change them.
2. Create roles that carry the `embermend:*` permissions each kind of operator needs, for
   example `embermend-lab` with `embermend:read`, `embermend:evidence` and
   `embermend:assess`, and a separate `embermend-lab-approver` with `embermend:approve`.
   Keep standing `embermend:policy`, `embermend:exception` and `embermend:recover` in their
   own roles and assign them only while needed.
3. Make sure the `hivexui-embermend` browser client policy in `IAM_BROWSER_CLIENT_POLICIES`
   lists every `embermend:*` permission operators should be able to use from HiveXUI.
4. Assign the roles to people, directly or through a group.
5. Configure Embermend's API and worker:

   ```bash
   EMBERMEND_AUTHORITY_SOURCE=oathweave
   EMBERMEND_OATHWEAVE_ROLE_SCOPES_FILE=/run/embermend/role-scopes.json
   EMBERMEND_OATHWEAVE_API_URL=https://identity.example.com/api/v1
   EMBERMEND_OATHWEAVE_TOKEN_URL=https://identity.example.com/api/v1/oauth/token
   EMBERMEND_OATHWEAVE_CLIENT_ID=embermend-directory
   EMBERMEND_OATHWEAVE_CLIENT_SECRET=<the machine client secret>
   # Service grants only (coordinators, integrations):
   EMBERMEND_IDENTITY_GRANTS_FILE=/run/embermend/grants.json
   ```

   Both processes log `authority.source` with the mode at startup.

To move an existing install over, create the roles and the mapping so every operator in
the grants file gets the same permissions and scope, remove the operator entries from the
grants setting, and switch the mode. Queued jobs and schedules created under a grant keep
running when the subject's roles cover the same scope and permissions, and are revoked
(or narrowed) otherwise, as when a grant changes. To go back, put the operator grants back
and unset `EMBERMEND_AUTHORITY_SOURCE` (or set it to `grants`).

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
