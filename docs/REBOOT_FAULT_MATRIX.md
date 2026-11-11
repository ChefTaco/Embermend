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
| Detached native worker SIGKILL, every dispatch/persistence cut, live clock changes and complete boot-loss recovery | Accurate original ownership and separately authorized recovery | Pending live proof |

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

The in-flight campaign deliberately remains incomplete: its reboot completed,
but its later action never dispatched. That action also requires independent
verification. The cancelled-schedule case deliberately retains one unknown native
lease. A healthy consumer after an unrelated reboot does not establish completion
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
merge remain separate gates;
production installation, signed release, combined suite restore and portfolio/web
updates follow full product acceptance.
