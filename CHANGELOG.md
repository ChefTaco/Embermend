# Changelog

## Unreleased

- Serve the suite audit export at `GET /api/v1/audit/export` for Cindertrace: every committed audit row as a strict HiveAuditRecord v1 (`hiveAuditRecordSchema`, `hiveAuditPageSchema`), oldest first by `(createdAt, id)` with opaque cursors and no retention window. It requires the new `embermend:audit:read` permission: service accounts read every installation, operators their own. Migration `20261112000000_audit_export` adds an `Audit (createdAt, id)` index for the cross-installation scan and records the actor kind on new audit rows. The route is in the OpenAPI document and the browser contracts.
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
