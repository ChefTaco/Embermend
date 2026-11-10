# Acceptance ledger

Status is evidence-based. Component tests and virtual-machine availability do
not establish integrated acceptance. The product remains a development preview
until all required journeys and failure cases have retained proof.

| Criterion | Implementation and verification checkpoint | Integrated acceptance |
|---|---|---|
| AC-01 | Required Magnus adapter, capability gating, degraded inspection | Pending |
| AC-02 | Scoped entities, immutable identities, provenance, repository rename regression | Pending |
| AC-03 | Versioned profiles; actual fixture hardening, recovery and recurrence on disposable guests | Partial fixture proof; broader hardening pending |
| AC-04 | Actual Canonical OVAL/OpenSCAP assessment; supervised security update handlers | Assessment proof only; update/activation acceptance pending |
| AC-05 | Actual syntax index; real Qwen, Codex CLI and Claude CLI controlled-corpus analysis; managed rootless broker | Partial provider/scanner proof; full managed journey pending |
| AC-06 | Candidate state and independent verification boundaries; partial-scan regressions | Pending |
| AC-07 | Application/source bindings and semantic anchors | Pending |
| AC-08 | Durable publication, explicit decision and standing-policy tests | Pending |
| AC-09 | Immutable plan revisions and policy revocation tests | Pending |
| AC-10 | Isolated preparation and bounded GitHub provider phases | Pending |
| AC-11 | Separate source/runtime state; source verification regression | Pending |
| AC-12 | Artifact/deployment entities and runtime digest verification | Pending |
| AC-13 | Campaign dependency, canary, disruption and pause boundaries | Pending |
| AC-14 | Independent security/health verification checks | Pending |
| AC-15 | Real native request with lost client reply reconciled under original identity | Partial; crash/reboot injection pending |
| AC-16 | Authoritative pause regression; recovery capability work remains | Pending |
| AC-17 | Separate container/workload/artifact identities | Pending |
| AC-18 | Target-kind capability boundary; contract fixtures remain | Pending |
| AC-19 | Scoped expiring exceptions and durable expiry events | Pending |
| AC-20 | Redaction and isolated source/model credential separation | Pending |
| AC-21 | Durable jobs, duplicate native delivery, exact PostgreSQL restore and restored history guards | Partial; full restart/hostile-work acceptance pending |
| AC-22 | Compact HiveXUI recommendations, decisions, pause and outcome view | Pending |
| AC-23 | Scoped exports; reporting and campaign completion work remains | Pending |
| AC-24 | Credential invalidation and consumer-migration verification regression | Pending |

## Retained development evidence

The [2026-11-10 evidence record](acceptance/2026-11-10-evidence.json) covers
three actual Magnus-enrolled Ubuntu 24.04 guests, separately authorized fixture
permission changes, independent native readback, duplicate delivery, a real
request with an intentionally lost client reply, authorized inode-mode recovery,
recurrence preserving earlier verification, vendor OVAL assessment and a
PostgreSQL-only restore rehearsal. No integrated criterion is complete.

The fixture has no application consumer. Fresh host heartbeats establish only
host-agent health. A later recurrence was secured again and remains open until
its own new independent security verification is recorded. The complete managed model,
GitHub/Compose journey, native crash/reboot continuation, combined suite restore
and production assessment remain unproven.

## Release gate

Retain exact source revisions, image digests, dependency versions, migration
checksums, model configuration references, target identities and receipt/evidence
digests for each integrated run. Private operational records stay outside Git.

Before a release, require complete integrated acceptance, fresh restore rehearsal,
privacy and secret scans, image checks, and the owning repositories' gates.
Only then install for authorized real-fleet inventory and assessment. Production
mutation policies remain disabled until explicitly granted.

The [inference evidence](acceptance/2026-11-10-inference.json) retains real
model/CLI identifiers and controlled corpus result digests for all three routes.
Findings remain candidates; repetition by different models does not validate
them. The out-of-scope application was excluded. No external repository or
production source was sent to a cloud model.
