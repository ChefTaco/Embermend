# Acceptance ledger

Status is evidence-based. Component tests and virtual-machine availability do
not establish integrated acceptance. The product remains a development preview
until all required journeys and failure cases have retained proof.

| Criterion | Implementation and verification checkpoint | Integrated acceptance |
|---|---|---|
| AC-01 | Required Magnus adapter, capability gating, degraded inspection | Pending |
| AC-02 | Scoped entities, immutable identities, provenance, repository rename regression | Pending |
| AC-03 | Versioned profiles; actual fixture hardening, recovery and recurrence on disposable guests | Partial fixture proof; broader hardening pending |
| AC-04 | Actual vendor OVAL/update, controlled-consumer restart and separately approved reboot with independent configured userspace ELF mapping verification | Partial; namespace/file-view attribution, other activation classes and package fault cases pending |
| AC-05 | Real model analysis through durable product jobs and a Magnus-enrolled rootless worker; three provider routes | Partial managed controlled-corpus proof; full journey pending |
| AC-06 | Real candidates; isolated SQLite and ownership probes; two validated findings and a disputed abstract-store finding; partial-scan regressions | Partial controlled-corpus proof |
| AC-07 | Application/source bindings and semantic anchors | Pending |
| AC-08 | Durable explanation before actual PR writing; coordinator self-approval refusal, separate operator decisions and standing-policy regressions | Partial authenticated host workflow; broader source/provider journey pending |
| AC-09 | Actual changed GitHub source head refused before provider writes; revision and revocation regressions | Partial stale-head and actual browser-session revocation proof; broader authority revocation pending |
| AC-10 | Actual Magnus preparation, linked GitHub PR, lost-reply adoption, required checks and separate non-bypass merge | Partial controlled source workflow proof; full authenticated journey pending |
| AC-11 | Independent immutable maintained-branch readback/probes for a source-only application; other branch occurrences remain open | Partial source-only branch proof; deployed-artifact cases pending |
| AC-12 | Actual immutable OCI rollout, reviewed local build evidence, independent image/container/application verification and actual durable hosted workflow-attempt tracking | Partial; isolated build/publication and signed provenance pending |
| AC-13 | Campaign dependency, canary, disruption and pause boundaries; actual browser pause before dispatch | Partial pause proof; staged campaigns pending |
| AC-14 | Independent managed permission readback and fresh host-agent health after browser-authorized change | Partial fixture proof; application health cases pending |
| AC-15 | Worker/control/rootless loss, reboot recovery after expiry, queue/receipt/result commit cuts, power loss and forward/backward clocks | Partial native fault matrix; remaining interruption cuts and unknown-owner recovery pending |
| AC-16 | Browser pause/resume, cancellation ownership, held leases across restart and separately approved original-inode recovery with independent verification | Partial; broader in-flight, browser recovery and other recovery classes pending |
| AC-17 | Actual Compose replacement and reboot instances, immutable artifact links and retained historical inventory | Partial; broader replacement and future contract fixtures pending |
| AC-18 | Target-kind capability boundary; contract fixtures remain | Pending |
| AC-19 | Actual scoped disposable exception expiry, durable expiry event, coordinator refusal and unchanged finding state | Partial fixture proof; broader operator lifecycle pending |
| AC-20 | Redaction and isolated source/model credential separation | Pending |
| AC-21 | Durable jobs, duplicate native delivery, worker/control recovery and isolated combined controller-suite restore with existing authentication, exact stores and history guards | Partial; remaining restart/hostile-work cases and signed-installation restore pending |
| AC-22 | Real Oathweave sign-in, scoped recommendations, evidence access, decisions, pause/resume, native hardening and package-activation reboot with independently verified outcomes | Partial authenticated fixture proof; wider operator journeys pending |
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
GitHub/Compose journey, the complete native crash/reboot matrix, combined suite restore
and production assessment were unproven at that initial checkpoint. Later dated
records below supersede individual gaps without completing the full acceptance ledger.

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


The [authenticated browser evidence](acceptance/2026-11-10-authenticated-browser.json)
retains a real Oathweave/HiveXUI journey through the reviewed Hive ingress contract,
using explicitly connected disposable product candidates and the actual Registry.
The coordinator published before mutation and was refused approval and policy
changes. The browser operator approved while paused, inspected evidence, resumed,
and started one native permission change. Independent managed inventory and a
technical reviewer established the effective mode and host-agent health. A fresh
26-table PostgreSQL restore preserved the data and append-only guards.

This test found and fixed three integration issues: navigation depending on an
unneeded Magnus browser client, old cached heartbeats blocking operator-reviewed
work despite fresh Magnus eligibility, and missing durable job blockers in the
operator timeline. Exact target identity and fresh eligibility remain mandatory.
The original refused attempt remains retained; a separately approved revision
performed the change. Current-revision reports exclude older executions and
publications; original receipt access checks its original revision's scope.

An actual Ardent 3 runtime then used the approved Qwen model and the Embermend
plugin over authenticated ingress to inspect findings and evidence. Its read-only
preview used only read/evidence scopes and made no write calls. This found and
fixed ingress prefix handling and list-result envelopes required by Ardent's
evidence recorder. The model summary is supporting context, never verification
authority. This is not a signed combined installation or a combined suite restore;
application-consumer health and the remaining acceptance matrix are pending.

Browser sign-out was also checked against a captured resource token: the same
operator token returned HTTP 200 before sign-out and HTTP 401 afterward while
still unexpired. This proves request-time browser session revocation, not
revocation of credentials already captured by a queued worker job.


The [reboot and artifact evidence](acceptance/2026-11-10-reboot-artifact.json)
adds an actual, initially configured and Magnus-enrolled Ubuntu guest. The
published and separately approved reboot scheduled one native operation. Its
45-second admission window expired before reboot completion; the original job
became unknown. A separate read/evidence/recover observer used only original
receipt GETs after the new boot, retained cancellation and the old deadline, and
completed the original job without renewed authority or another dispatch.
Independent inventory and consumer health passed while the application finding
correctly remained affected.

A second separately approved plan replaced one Compose service with a reviewed
immutable OCI digest. The build context contained only two committed, inert
fixture files. Independent managed inventory confirmed the actual image/config
and replacement container, and live consumer probes allowed the expected owner
while returning HTTP 403 for cross-owner access. Runtime verification passed;
source work stayed open. Earlier container instances and observations remain
retained, and replaying old native inventory cannot overwrite the current deployment, including when delivered inside a fresh receipt envelope. Repeated inventory corroborates stable relationships without replacing their original provenance.
Duplicate job/execution delivery retained the same identities. Exactly one
native reboot and one native rollout were observed, with released leases.

This stage exercised product permissions through authoritative core actors and
existing native service authentication; the earlier browser record is the
separate Oathweave journey. Builds used trusted local acceptance tooling and a
disposable registry. Subsequent hosted build tracking, native agent SIGKILL and
vendor package activation have separate evidence below. Complete isolated
build/publication, signed provenance, cancelled-schedule faults, combined suite
restore and the full acceptance matrix remain pending. Its PostgreSQL-only restore matched all 26 tables and
preserved append-only guards. No production policy or host changed.

The [hosted build-tracking evidence](acceptance/2026-11-10-build-tracking.json)
retains actual GitHub workflow-attempt reads through the disposable durable
worker. Source, repository, workflow and attempt identities are checked; repeated
submission keeps the same job. A real worker SIGKILL after the provider read and
before database persistence rolled back the uncommitted build facts. After an
explicit restart, the original job became unknown with its deadline expired and
cancellation retained. A separate read/evidence/recover observer completed that
same job through provider reads. No workflow was started or rerun by this path.

Existing browser authentication read the scoped build evidence. An operator
without assess permission was refused observation creation despite its suite
administrator role. The existing coordinator saw no out-of-scope application
builds and was refused an out-of-scope observation. No identity grant expanded.
Observation creation used an authoritative-core acceptance actor, separately
from those browser/machine access checks. Successful workflow conclusions retain
unestablished artifact provenance and do not close source or runtime work.
A fresh PostgreSQL-only restore again matched 26 tables and append-only guards.

The same record covers an actual scoped exception expiring under the running
worker: its owner and rationale remained, one durable expiry event appeared,
and findings and verification stayed unchanged. Coordinator acceptance and
replaying the expired request were refused. Separately, a paused disposable VM
produced a visible capability failure before native execution admission.
Unpausing it restored fresh managed inventory and the fixed application's health;
the cross-owner request remained HTTP 403. Source work stayed open, and earlier
runtime verification remained retained. This outage case does not establish
in-flight offline recovery or native agent crash acceptance.

The [native package evidence](acceptance/2026-11-10-native-package.json) records
a fresh enrolled Ubuntu guest with a real vendor OVAL finding for zlib. A
published and separately approved preview survived SIGKILL of the native agent
daemon after its queued receipt. The restarted agent retained the original
operation, which completed with released ownership. Native records retain one
preview, one package application and one separately authorized consumer restart.

Applying the exact security-pocket version changed the installed library while
the healthy, unchanged consumer process still held the old copy. Its separate
restart loaded the patched library. Fresh complete OVAL assessment stopped
reporting that package advisory. Other host consumers remain unexamined, so the
host occurrence deliberately stays affected. This proves installed-versus-running
separation for the controlled consumer; it does not establish full host activation
or the package lock, held package, dependency or interrupted-transaction matrix.
The retained PostgreSQL restore again matches all 26 tables and history guards.

The [package activation evidence](acceptance/2026-11-10-package-activation.json)
records another fresh enrolled guest using bounded native package mapping
inventory. A real vendor update left seven processes mapping the old library.
The existing OAuth coordinator published an exact reboot plan and was refused
self-approval. The existing browser operator approved, paused, resumed and started
that plan. Start was disabled while paused, and no execution existed before start.
The original native reboot operation completed once with released ownership.

Fresh authenticated managed inventory established the subsequent boot and six
current mappings; a fresh complete vendor assessment no longer reported the
package advisory. The controlled consumer was healthy and loaded the installed
library. A separate scoped technical-review core actor recorded verification for
the configured zlib userspace ELF package on this host without container
workloads. Browser credentials did not gain verification-ingestion authority.
Thirteen other OS package occurrences remained affected. Namespace/file-view
attribution and other activation classes still require their own evidence.

The existing disposable operator and coordinator grants gained only the fresh
application and target; their operation permission arrays and credentials stayed
unchanged. Coordinator standing-policy edits remained forbidden. Actual browser
evidence access and the verified recommendation outcome were retained. Replaying
the actual old vendor capture in simulated fresh envelopes retained one
historical observation, one occurrence and the earlier verification, without
another native action. A coherent campaign report and another exact 26-table
PostgreSQL restore with append-only guards were retained. All integrated criteria
remain partial or pending; production mutation policies stay disabled.

The [native reboot/cancellation matrix](REBOOT_FAULT_MATRIX.md) and its
[dated evidence](acceptance/2026-11-11-reboot-cancellation.json) retain actual
queued cancellation, an acknowledged reboot surviving cancellation/pause and
agent SIGKILL, and a cancelled host schedule followed by an unrelated reboot.
The last case remains unknown with one held native lease, including after a
control-service restart. No lease was cleared and no finding was closed.
Independent inventory and consumer health corroborate only the actual original
reboot case. Two reproduced admission defects now have regression fixes: exact
trusted shutdown-event binding and transactional campaign-job admission fencing.
The current code passes 53 unit and 43 PostgreSQL tests; Magnus passes its full
repository gate and 37 focused reboot/recovery cases. Another PostgreSQL-only
restore matched all 26 tables and history guards. The full native matrix and
combined suite restore remain outstanding.

The [native supervisor crash record](acceptance/2026-11-11-native-worker-crash.json)
adds a separate enrolled guest with actual main-worker SIGKILL after child
analysis started. Its expired original job and the same single observation remain
unknown with held ownership even after the cgroup became empty. The host agent
stayed active, prior findings stayed affected, and no operation was replayed.
The observation used its own bounded deadline. Rootless worker loss remains
unproven. A new PostgreSQL-only restore matched all 26 tables and history guards.

The [Hive installer integration](acceptance/2026-11-11-hive-installer.json) is
merged after all hosted checks. It offers Embermend only in a future compatible
signed release, defaults to off and requires explicit Magnus bridge metadata.
Existing signed release bytes remain unchanged. Component installer acceptance
does not establish full product acceptance, fleet installation or production
readiness. Portfolio and website updates remain gated on production rollout.

The [rootless worker evidence](acceptance/2026-11-11-rootless-worker-loss.json)
records a killed scanner container with confirmed cleanup and failure, followed
by detached owner loss while another rootless scanner remained active. The latter
retained unknown ownership and preserved three real-model candidates.

The [native continuation evidence](acceptance/2026-11-11-native-fault-continuation.json)
records original-operation recovery after control loss and authorization expiry,
failed first terminal-result persistence, hypervisor power loss before shutdown,
and a forward guest clock step. Healthy boots without valid original evidence
did not close the uncertain operations or security findings. These newer cases
supersede the rootless and specific fault gaps noted in earlier dated records;
the complete interruption matrix and authorized recovery still remain pending.

The [combined controller-suite restore](acceptance/2026-11-11-combined-suite-restore.json)
now has a cold backup and a fresh isolated restore using existing authentication.
Both PostgreSQL databases match across 138 tables, both SQLite stores match and
pass integrity/foreign-key checks, and both Redis stores retain non-expired values
and absolute expiries. Hash fields use canonical comparison; full stream state
includes consumer groups. One expired key is accounted for by its captured deadline.
The restored API serves matching findings/recommendations, Registry data and UI,
refuses unauthenticated reads, preserves all five unknown held native leases and
enforces the audit history guard. All mounts use restored files, with no published
ports or fleet/provider access. Source services recovered with eight fresh enrolled
fixtures, no active product jobs and no standing mutation policies. This is a lab
controller-suite rehearsal; managed disks and the future signed installation are
outside its scope. Failed preliminary rehearsals remain retained separately.

The [next fault/recovery record](acceptance/2026-11-12-clock-interruption-recovery.json)
adds backward clock and queue/receipt/result commit cuts. Admission expired under
the controller clock, and only original trusted evidence later completed the
reboot. A post-ingestion interruption reproduced an immutable-evidence conflict;
the deployed fix recovered the same operation while retaining the original
evidence. Changed cached request bindings and changed legacy result content
remain refused. All 47 PostgreSQL integration cases and strict repository gates
pass.

The same record tests separately approved configuration recovery: ordinary and
coordinator authority fail, a stale precondition fails without mutation, and a
fresh recovery restores the original inode mode. Independent readback and health
evidence verify only that fixture mode occurrence. Existing browser permission
ceilings remain unchanged; the positive test uses scoped core fixture actors and
existing native service authentication. It neither closes the unrelated package
finding nor clears any of the five earlier unknown native owners.

The [fresh current-runtime restore](acceptance/2026-11-12-suite-runtime-restore.json)
adds exact captured runtime restrictions and healthy configured probes. The prior
restore harness omitted health/security/resource overrides; its store and
authentication proof remains retained, while the corrected fresh rehearsal
establishes these additional runtime facts. Complete signed-installation and
fleet disaster recovery remain separate.
