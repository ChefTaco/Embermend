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
| AC-05 | Real model analysis through durable product jobs and a Magnus-enrolled rootless worker; three provider routes | Partial managed controlled-corpus proof; full journey pending |
| AC-06 | Real candidates; isolated SQLite and ownership probes; two validated findings and a disputed abstract-store finding; partial-scan regressions | Partial controlled-corpus proof |
| AC-07 | Application/source bindings and semantic anchors | Pending |
| AC-08 | Durable explanation before actual PR writing; coordinator self-approval refusal, separate operator decisions and standing-policy regressions | Partial; authenticated operator journey pending |
| AC-09 | Actual changed GitHub source head refused before provider writes; revision and revocation regressions | Partial; broader revocation acceptance pending |
| AC-10 | Actual Magnus preparation, linked GitHub PR, lost-reply adoption, required checks and separate non-bypass merge | Partial controlled source workflow proof; full authenticated journey pending |
| AC-11 | Independent immutable maintained-branch readback/probes for a source-only application; other branch occurrences remain open | Partial source-only branch proof; deployed-artifact cases pending |
| AC-12 | Artifact/deployment entities and runtime digest verification | Pending |
| AC-13 | Campaign dependency, canary, disruption and pause boundaries | Pending |
| AC-14 | Independent security/health verification checks | Pending |
| AC-15 | Actual worker SIGKILL and control restart; original native receipt observed after natural lease/deadline expiry without dispatch | Partial crash proof; native agent/reboot cases pending |
| AC-16 | Authoritative pause regression; recovery capability work remains | Pending |
| AC-17 | Separate container/workload/artifact identities | Pending |
| AC-18 | Target-kind capability boundary; contract fixtures remain | Pending |
| AC-19 | Scoped expiring exceptions and durable expiry events | Pending |
| AC-20 | Redaction and isolated source/model credential separation | Pending |
| AC-21 | Durable jobs, duplicate native delivery, real worker/control restart recovery, exact PostgreSQL restore and restored history guards | Partial; coordinator/native restart and hostile-work acceptance pending |
| AC-22 | Compact HiveXUI recommendations, decisions, pause and outcome view | Pending |
| AC-23 | Scoped exports and retained actual source-campaign report; completion/reporting work remains | Partial controlled report proof |
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

The [managed source evidence](acceptance/2026-11-10-managed-source.json) covers
a real durable scan on an enrolled rootless worker and original/draft executable
probes on a separately prepared guest. The same probes ran in both revisions.
SQLite injection and owner filtering received technical validation; the abstract
store finding remains disputed. A separately published and explicitly approved
plan was refused against the actual changed GitHub head before provider writes.
These initial preparation edits did not change a maintained branch, built
artifact or deployment; the subsequent source workflow below has its own proof.

The [worker recovery evidence](acceptance/2026-11-10-worker-recovery.json) covers
actual product worker loss and a disposable control-service restart during an
isolated preparation. The original lease and deadline expired naturally. A
separate read/evidence/recover principal observed the original native receipt,
preserved cancellation intent, and confirmed released ownership with one receipt
GET and no dispatch. Native agent crashes, reboot continuation, and the remaining
dispatch/persistence fault points are not established by this combined case.

The [source workflow evidence](acceptance/2026-11-10-source-workflow.json) covers
actual [PR creation and merge](https://github.com/ChefTaco/Embermend/pull/2) into
a dedicated protected acceptance branch. The product published its exact plan
before writing and refused coordinator self-approval. A deliberately lost
creation reply was reconciled to the original PR without another mutation.
Required checks passed; a writer without merge permission was refused, and a
separate decision authorized one asynchronous merge with rule bypass disabled.

Independent Magnus jobs then read and tested the resulting immutable commit.
The two conditional SQL/owner findings were source-verified on that branch;
three occurrences on the other maintained branch remained open. The abstract
path-handling finding remains disputed and open. The application is explicitly
source-only. No artifact publication, deployment, production exposure or runtime
closure is claimed. The direct-service harness does not replace the authenticated
browser/Oathweave/coordinator-runtime journey. A fresh PostgreSQL-only restore
retains the resulting plans, phase identities, verification and append-only guards.
