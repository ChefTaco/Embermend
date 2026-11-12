# Native reboot and cancellation acceptance

The [dated evidence](acceptance/2026-11-11-reboot-cancellation.json) retains a
bounded disposable run. Full native fault acceptance remains incomplete.

| Fault or boundary | Required outcome | Retained proof |
|---|---|---|
| Queued product cancellation | Cancelled job, no native reservation or reboot | Actual worker stop/start and enrolled guest |
| Cancellation after claim, before admission | No external dispatch | PostgreSQL regression with cancellation during capability read |
| Deadline, worker lease or job binding changes before admission | No external dispatch | PostgreSQL regression for each boundary |
| Accepted reboot, then product cancellation and campaign pause | Original native work stays owned; later actions stop | Actual guest and product worker |
| Native agent daemon SIGKILL after schedule acknowledgement | Original operation survives restart; no new reboot request | Actual guest and original receipt |
| Normal subsequent boot with exact shutdown event | Complete original operation, release ownership; health remains separate | Actual guest, trusted event digest and independent inventory/consumer health |
| Acknowledged schedule cancelled, followed by unrelated reboot in the old window | Unknown original outcome and held ownership | Actual private fault injection; repeated receipt reads |
| Control restart with the cancelled operation still held | Original request and lease persist; no replay | Actual control restart and unchanged operation/lease rows |
| Missing/lost acknowledgement or duplicate delivery | Unknown; never reschedule the original operation | Focused component cases |
| Missing, malformed, oversized, ambiguous, forged or mismatched shutdown evidence | Unknown and owned | Focused component cases |
| Early/late boot, invalid uptime or changed identity/policy | No inferred completion | Focused component cases |
| Detached native supervisor worker SIGKILL during vendor assessment | Missing owner completion proof stays unknown; host agent and prior findings remain intact | Actual separate enrolled guest, original expired job and one bounded observation |
| Rootless scanner container SIGKILL with its owner alive | Failed analysis and release only after confirmed container/mount cleanup | Actual fresh enrolled rootless worker |
| Detached supervisor SIGKILL with rootless scanner still active | Original operation remains unknown and owned; prior findings remain | Actual immediate container/process evidence and unchanged real-model candidates |
| Control SIGKILL after schedule acknowledgement, with restart after original expiry | Read-only recovery of the same operation; no extended grant or new dispatch | Actual reboot while control was offline and one completed observation |
| First terminal inventory-result persistence fails | Unknown until persistence recovers; original job can be observed after expiry | Actual temporary target-scoped database fault and one original operation |
| Hypervisor power loss before owned shutdown | A subsequent healthy boot cannot establish completion | Actual offline target, expired job and held original operation |
| Forward guest clock step after schedule acknowledgement | Out-of-bounds trusted shutdown evidence cannot establish completion | Actual clock step, shutdown journal, new boot and restored clock |
| Backward guest clock step after schedule acknowledgement | Original controller deadline still expires; later completion requires exact owned shutdown/boot proof | Actual expired job, restored clock and read-only completion of the same operation |
| Control queue claim commit fails until original expiry | One reservation; expired work is not dispatched | Actual targeted database fault, no native command or lease |
| Product terminal receipt commit fails | Observe the original completed operation after persistence recovers | Actual targeted database fault and one native command |
| Product result checkpoint fails after evidence ingestion | Resume without rewriting immutable evidence or dispatching again | Actual failure, deployed fix and same-operation recovery; PostgreSQL regressions |
| Separately approved original-inode configuration recovery | Separate operator permission/approval; stale preconditions cannot mutate | Actual refused attempts, recovery, independent readback and health verification |
| Remaining dispatch/persistence cuts and recovery of unknown owners or other action classes | Accurate original ownership and separately authorized recovery | Pending live proof |

The reproduced scheduling defect used timing and a changed boot ID to infer
completion. That could misattribute an unrelated reboot after cancellation.
Adoption now also requires the previous boot's trusted logind shutdown event with
the exact operation marker, root UID, executable, unit, transport, mode and bounded
timestamp. Missing persistent journal evidence stays unknown. Observation never
schedules work or clears a lease.

Campaign dispatch now checks its original durable job inside admission
transactions, including each provider phase. Cancellation serializes with those
checks. A delayed heartbeat, changed owner, expired lease or deadline cannot
authorize a new effect. Read-only reconciliation has a separate bounded job;
it preserves the original cancellation flag and deadline and cannot start a
missing action.

The separate [native supervisor crash evidence](acceptance/2026-11-11-native-worker-crash.json)
records actual SIGKILL of its detached main worker after the vendor-analysis
child started. The host agent remained active with the same PID. The cgroup was
empty at later observation, but the owner completion report was missing, so both
the expired original assessment and its single bounded observation stayed unknown.
Existing vendor findings remained affected. The first private harness waited too
briefly for that observation; its continuation reused the same identities and did
not repeat the fault. The immediate post-signal process count was not retained,
so this case makes no claim about immediate child survival. Rootless container
worker loss is now covered separately by the
[rootless fault evidence](acceptance/2026-11-11-rootless-worker-loss.json).

That rootless run distinguishes a killed scanner container with its owner alive
from a lost detached owner. The first failed with confirmed cleanup and ownership
release. In the second, the container was still running immediately after the
owner died; the original operation stayed unknown even after its container later
disappeared. Three candidates from a real configured model scan remained unchanged.

The [native continuation evidence](acceptance/2026-11-11-native-fault-continuation.json)
adds control loss through reboot and original authorization expiry, failed first
terminal-result persistence, hypervisor power loss before shutdown, and a forward
clock step. Recovery of known completion used the original identity and deadline.
Power loss and out-of-bounds shutdown timing retained unknown ownership. These
cases do not establish all interruption cuts or separately authorized recovery.

The [backward-clock and recovery evidence](acceptance/2026-11-12-clock-interruption-recovery.json)
adds a backward clock step, three further commit cuts and a separately approved
configuration recovery. The backward step did not extend admission. After clock
correction, original shutdown and boot evidence established the same operation's
completion. An interrupted post-ingestion checkpoint exposed an envelope-time
bug; recovery now reuses retained terminal receipts and the original immutable
evidence time, while rejecting changed request bindings or content.

Recovery authority was tested separately from ordinary execution and approval.
The positive case uses scoped authoritative-core fixture actors with existing
native service authentication. Existing browser permissions remain unchanged;
this is not a new browser recovery journey or clearance of uncertain ownership.

The in-flight campaign deliberately remains incomplete: its reboot completed,
but its later action never dispatched. That action also requires independent
verification. The cancelled-schedule and native-supervisor cases each deliberately
retain an unknown native lease. A healthy consumer after an unrelated reboot does not establish completion
of the original operation. The vendor package finding stays affected; these fault
cases perform no package repair or security verification.

The harness uses existing native service authentication and scoped authoritative
core actors. It is not a new browser authorization journey. The preconfigured
private hypervisor channel is outside product execution and cannot serve as a
remediation fallback. The runtime and node were configured before enrollment;
the enrolled guest was not reconfigured through SSH.

Hive's optional installer path now requires a signed, explicit Magnus protocol
declaration and defaults to off. Local installer and initialization tests,
compatibility and restore fixtures, and privacy checks pass. Hosted checks and
merge have passed for that installer integration. A
[combined lab controller-suite restore](acceptance/2026-11-11-combined-suite-restore.json)
also preserves existing authentication, stores, runtime artifacts and all five
held native leases in isolation. It does not restore managed guest disks or
establish a signed product installation. Production installation, signed release
and portfolio/web updates follow full product acceptance.
The [fresh runtime restore](acceptance/2026-11-12-suite-runtime-restore.json)
also compares captured container restrictions and health-check overrides. It
supersedes the earlier harness's omitted runtime overrides while retaining the
earlier store and authentication evidence.


All five owners retained by the cancelled-schedule, detached assessment owner,
rootless supervisor, power-cut and forward-clock cases now have separately
published and explicitly approved signed ownership settlement. Independent review
checks empty execution groups, absent schedules/containers and unmounted worker
paths. Original requests, commands, fences, deadlines and historical unknown
outcomes remain retained. No new native command is created and no finding closes.
The rootless case also demonstrates lost recovery-result persistence and read-only
adoption of the same signed decision. See the
[recovery evidence](acceptance/2026-11-12-authorized-owner-recovery.json).
