# Changelog

## [Unreleased]

- Grants can change without a restart: `EMBERMEND_IDENTITY_GRANTS_FILE` names a JSON grants file (the same format as `EMBERMEND_IDENTITY_GRANTS`, which stays supported; configure exactly one). The API and worker check it for changes at most every two seconds, so onboarding, narrowing or revoking an operator, collector or coordinator applies to new requests, queued jobs and scheduled deliveries within seconds (`grants.reloaded`). An invalid replacement is logged as `grants.reload_failed` and the last valid grants stay in force.
- The suite audit export carries what Cindertrace needs to correlate Embermend with host evidence: finding records (`finding.observed`, `finding.recurred`) have the finding's `severity`, `kind`, `priority` and occurrence subject in `details`, finding and execution records name the Magnus node (`subject.nodeId`) of the host or workload host involved, and an execution reported or reconciled as `unknown` is exported with outcome `failure`, like a failed one. Findings recorded before this release have no severity details.
- List endpoints filter by scope inside the database query. `GET /api/v1/findings`, `/entities`, `/relationships`, `/profile-assignments`, `/exceptions` and `/builds` used to read the first 1000 (or 2000) rows of the installation and drop out-of-scope rows afterwards, so a narrowly scoped operator could get an incomplete list. `findings()` no longer runs one occurrence query per finding, and occurrence visibility reads subjects and evidence in batches.
- The recommendations timeline (`GET /api/v1/recommendations`, also in `/api/v1/export`) is ordered by each plan's last change, newest first. It used to return an arbitrary 200 plans that could omit the newest. Its campaign jobs, publications, executions and campaigns are read once per page instead of several queries per plan.
- Cursor pagination for those seven list endpoints: with `?limit=` (1-200, default 50) or `?after=<cursor>` the response is a `{ data, nextCursor }` page, like `/api/v1/hive/events`. Without either parameter the legacy array is returned, as before, with an `x-next-cursor` header when the list was cut at its legacy bound (200 recommendations, 2000 relationships, 1000 of the rest). An invalid query or cursor is `400 INVALID_LIST_QUERY` or `400 INVALID_LIST_CURSOR`. Findings and recommendations page newest first, the other lists by ID.
- An identity-provider outage is no longer a 401. When Oathweave's JWKS or userinfo endpoint cannot be reached or answers 5xx, authenticated routes return `503 IDENTITY_PROVIDER_UNAVAILABLE` with `Retry-After: 1` and log `api.identity_provider_unavailable`; a revoked session (userinfo 401 or 403), a bad token or a missing grant is still `401 IDENTITY_OR_PRODUCT_ACCESS_DENIED`. Refusal logs now carry the verifier's reason.
- Oathweave tokens are verified with the shared `@hivemagnus/hive-common` verifier instead of hand-rolled `jose` checks: the same RS256, issuer, `embermend` audience, 900-second lifetime, `jti`, actor-type and per-request userinfo rules. The Ardent plugin's client-credentials provider runs on the shared `createServiceTokenProvider()`, which also backs off briefly after a failed token request.
- The API uses the hive-common server kit: every response, errors included, carries `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`, and a new unauthenticated `GET /health/ready` checks PostgreSQL (503 when it does not answer). The container healthcheck of the API probes `/health/ready`, so a lost database now marks the API unhealthy. `GET /health/live` keeps its body.
- `MAGNUS_URL` may carry a base path (`https://gateway.example.com/magnus`): Magnus routes are joined under it instead of replacing it.
- Dependencies: `@hono/node-server` 2.1.11 (its 2.1.7, 2.1.10 and 2.1.11 security fixes concern `serveStatic` and WebSocket upgrades, which Embermend does not use), `hono` 4.13.22, `@hivemagnus/hive-common` 0.6.1, and the Ardent plugin is tested against `@hivemagnus/ardent` 3.3.0.
- The worker drains on SIGTERM instead of aborting at once: it stops claiming, lets running jobs finish their current receipt or verification wait for up to `EMBERMEND_WORKER_DRAIN_SECONDS` (default 8), and a campaign between actions returns to the queue to resume later instead of becoming `unknown`. A second signal, or the end of the drain time, interrupts as before.
- `EMBERMEND_WORKER_CONCURRENCY` (1-8, default 1) runs that many jobs at once in one worker. Maintenance and schedule delivery now run in their own loop every second, so a long job no longer delays exception expiry or scheduled work.
- Integration tests cover maintenance and schedule delivery: exception expiry and its outbox notice, one enqueue per due schedule, disabled and not-yet-due schedules, delivery, cancellation of a disabled schedule's occurrence, and an admission failure blocking delivery.

### Upgrade notes

- Migration `20261126000000_list_paging` adds `Plan.updatedAt` (backfilled from each plan's newest revision), list-order indexes on `Plan`, `Finding`, `Entity`, `Exception`, `ProfileAssignment` and `Build`, and a partial index on campaign jobs' `payload->>'planId'`. Suite upgrades need `--allow-migrations`.
- Clients that read the plain arrays keep working unchanged. To read beyond the legacy bound, follow `x-next-cursor` or request pages with `limit`.
- Clients that treated every authentication failure as a sign-out should retry a 503. Monitoring that alerts on the API container's health now also fires when PostgreSQL is unreachable.
- Docker and Compose send SIGKILL 10 seconds after SIGTERM unless `stop_grace_period` is longer, so keep `EMBERMEND_WORKER_DRAIN_SECONDS` below the worker container's grace period.

## [0.4.0] - 2026-11-26

- Security: the worker checks the stored authority of every job and scheduled delivery against the current `EMBERMEND_IDENTITY_GRANTS` before acting. Removing an operator's grant, changing its kind or narrowing its scope used to leave queued or resumed campaigns and recurring scans and assessments running under the old grant. Such a job now fails with `ACTOR_GRANT_REVOKED`, `ACTOR_KIND_CHANGED` or `ACTOR_SCOPE_REVOKED` (audit `job.authority-revoked`), and a scheduled occurrence is blocked (audit `schedule.blocked`). Removed permissions are intersected away (audit `job.authority-narrowed` or `schedule.authority-narrowed`), so work continues only while it still has the permission its normal admission checks. No migration.
- The worker loop logs and backs off (up to 30 seconds) when maintenance, schedule delivery or a claim fails, for example while PostgreSQL is unavailable, instead of exiting without a message.
- Server-side failures are logged as structured, redacted JSON lines on stderr with the request ID: API 500 responses (`api.request_failed`), refused authentication, which includes identity-provider outages (`api.authentication_refused`), and unexpected worker failures (`worker.job_failed`). Lines carry error names and codes, never messages. API responses now carry `x-request-id`.
- CI runs the verify and integration gates on Node 24.22.3 and 26.13.1 (the image runtime) and fails on any moderate or higher `npm audit --omit=dev` finding.
- README and implementation status name the current suite pins: Hive 3.14.3 pins Embermend 0.3.4 with Magnus 3.3.6 and HiveXUI 0.12.0.

### Upgrade notes

- Work stops when its stored authority no longer matches `EMBERMEND_IDENTITY_GRANTS`. After upgrading, queued or resumed jobs whose operator grant was removed, changed kind or lost scope fail with an `ACTOR_*` code, and scheduled occurrences of that operator are blocked; neither is retried. Review `job.authority-revoked`, `job.authority-narrowed`, `schedule.blocked` and `schedule.authority-narrowed` audit entries, and recreate the work under an operator that holds a current grant if it should continue.
- No migration and no new setting.

## [0.3.4] - 2026-11-20

- Security: force `effect` to 3.22.1 through an npm override, fixing CVE-2026-121707 (ReDoS in `Schema.TemplateLiteral`) in the container images. Its only consumer is the Prisma CLI configuration loader used for migrations, not request handling. No migration.

## [0.3.3] - 2026-11-20

- Redact private-key blocks with a linear scan instead of a regex that took quadratic time on text with many unmatched `-----BEGIN …PRIVATE KEY-----` markers (CodeQL `js/polynomial-redos`). The same blocks are redacted, with their line count kept.

## [0.3.2] - 2026-11-15

- Update `@hivemagnus/hive-common` to 0.5.0. Through its log redaction, the suite audit export now also masks URL credentials without a user or without a password (`scheme://:password@host`, `scheme://token@host`) and detail values under keys containing `jwt`, `bearer` or `signature`. The HiveEvent feed sorts and resumes with the shared `(occurredAt, id)` comparators, which order events exactly as before.

## [0.3.1] - 2026-11-13

- Keep the `authorizationId` of a policy authorization in the suite audit export instead of masking it as a secret, and hold the 4 KB details bound after redaction.
- Omit a source file that is not UTF-8 from a repository scan as `unsupported-encoding` (partial coverage) instead of failing the whole scan.

## [0.3.0] - 2026-11-12

- Serve the suite audit export at `GET /api/v1/audit/export` for Cindertrace: every committed audit row as a strict HiveAuditRecord v1 (`hiveAuditRecordSchema`, `hiveAuditPageSchema`), oldest first by `(createdAt, id)` with opaque cursors and no retention window. It requires the new `embermend:audit:read` permission: service accounts read every installation, operators their own. Each page's `nextCursor` is its last record's cursor; it is `null` only when a page is empty. The optional `OATHWEAVE_NATIVE_ISSUERS` setting accepts native-issuer Oathweave service tokens, limited to `audit:read`. Migration `20261112000000_audit_export` adds an `Audit (createdAt, id)` index for the cross-installation scan and records the actor kind on new audit rows. The route is in the OpenAPI document and the browser contracts.
- Add the opt-in `emberpath` inference preset, an alias of `openai-compatible` that takes an HTTPS Emberpath `url` (the API is `<url>/v1`) and defaults `ref` to `emberpath` and `tokenEnv` to `EMBERPATH_API_KEY`. Existing provider configurations are unchanged.

## [0.2.0] - 2026-11-12

- Serve the Hive:Magnus event feed at `GET /api/v1/hive/events`: HiveEvent v1 records derived from committed audit rows for new recommendations, decisions, campaign pauses and verification stops, and failed or unknown execution outcomes, with the recommendation read rules, 14-day retention, cursor paging and strict `@hivemagnus/hive-common` validation. The route is in the OpenAPI document and the browser contracts (`hiveEventSchema`, `hiveEventPageSchema`).

- Document the completed reference acceptance, the signed-suite installation and restore, and the scoped production assessment rollout.

## [0.1.0] - 2026-11-12

- Add gated native multi-architecture runtime and scanner releases with exact scanned configurations, SBOMs, provenance, compatibility metadata and attested public package tarballs.
- Retain extended disposable campaign, source-to-image, credential, exception, outage, hostile worker and temporary-container acceptance evidence.

- Preserve the reviewed worker executable alias when using the patched shared runtime, and exercise source/preparation entry commands in image CI.

- Keep application-wide finding and campaign-report reads within the reader's runtime subject scope; verification history follows only visible occurrences.

- Require independent security evidence for the current immutable controlling artifact before code, dependency or image runtime closure; container-only repairs can remain recorded mitigations.

- Expose typed campaign reports and exception-expiry reads to Ardent without granting exception acceptance or other operator authority.

- Publish independently reviewed OCI artifacts through a separate scoped decision, preserving platform and attestation digests; reconcile lost registry replies through reads without replaying writes.

- Scope source findings and scanner evidence to their application independently of worker hosts, retaining versioned execution references so supported findings survive worker replacement without granting access to host evidence.

- Recheck repository identity and current disclosure, execution and path policy immediately before queued source work is admitted; record known refusals without dispatch or invented unknown ownership.

- Derive authorization and other non-sink finding anchors from source syntax rather than variable model explanations, preserving supported file moves and flagging duplicate anchors for review.

- Bind globally distinct deployment records to Magnus resources within the exact target namespace, preserving native identifiers and refusing ambiguous mappings before rollout.

- Yield deliberate canary-verification waits durably so a single worker can run independent assessments, then resume the same campaign job without extending its deadline or replaying admitted actions.

- Keep staged campaigns waiting for independent canary verification within their original deadline, rechecking authorization and pause before the next action.
- Preserve ambiguous code anchors as separate reviewable findings and retain every credential-exposure location with distinct immutable evidence.

- Preserve confirmed campaign failure as a terminal observation, validate future container-agent scope/identity contracts, and let an existing authorized human operator make a separate exact recovery decision without requiring another human identity.

- Add separately approved unknown-owner settlement with fresh independent effect review, exact native request/fence binding and read-only adoption after lost acknowledgement. Ownership release preserves the unknown historical outcome and does not close findings or resume campaigns.

- Reuse retained completed assessment receipts after interrupted result checkpoints, preserving immutable evidence and original request binding without redispatch. Older interrupted observers also retain the already-ingested evidence timestamp while all other immutable fields must still match.

- Require the verification operation for verified closure; finding ingestion preserves immutable occurrence identities and cannot invent source/runtime verification.

- Use an explicit public automation identity for provider-created commits instead of inheriting an operator profile email.

- Reconcile a lost PR-creation reply through exact branch/head/operation evidence without another write; permit separately authorized no-effect recovery when no provider mutation was reserved, with concurrent admission guards.

- Retain complete managed assessment identities and observe original receipts after worker loss or execution deadlines, without redispatch or clearing cancellation; preserve verified history on duplicate evidence ingestion.

- Evaluate GitHub operations by permission and live merge readiness instead of rejecting repository administrators; explicitly disable rule bypass and retain asynchronous merge identities for read-only reconciliation.

- Preserve explicit partial scanner coverage on model-broker failures; exercise source reading, preparation and broker errors inside the built container in CI.

- Accept the reviewed Node executable path used by the suite runtime for isolated validation, and verify that image path in CI.

- Apply monorepo application scope before reading scanner files or spending source budgets; retain excluded, unsupported and unsafe filesystem entries as explicit coverage.

- Add isolated Codex and Claude CLI inference brokers and approved network llama.cpp support, with exact model/version checks, source-disclosure permissions and bounded cancellation.
- Require patched Node.js 24.22.3 or 26.13.1, update builder and CI pins, and upgrade Hono to 4.13.18 for bounded memory when requests arrive in tiny transfer chunks (GHSA-39q9-qp46-w8xg).

- Preserve resource scope across identity reconciliation, policy/plan revisions and campaign membership; serialize finding IDs and require review when a match changes component or classification.

- Consume the suite's released Ardent 3.0.0 plugin API and shared Node runtime image.

- Establish strict TypeScript 6.0.3 workspaces, product contracts, PostgreSQL
  state, authorization, durable jobs, evidence, and verification boundaries.
- Add the custom source-analysis scanner and typed Ardent coordinator plugin.
- Add managed Magnus execution, versioned posture profiles, vendor OVAL/Trivy
  adapters, bounded provider operations and the compact HiveXUI integration.
- Require branch/component-bound source verification, restricted-evidence access,
  exact displayed revisions, authoritative environment checks and independent
  effective-state evidence.
- Retain partial disposable-host and PostgreSQL restore evidence; no release or
  production automation is enabled.

This development record does not establish integrated product acceptance.
