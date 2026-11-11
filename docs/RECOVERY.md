# Managed assessment recovery

Admission deadlines bound new work. They do not erase ownership or prevent
reading the outcome of work that Magnus already admitted.

Before dispatching an assessment, scan, source read or isolated preparation,
the worker retains the original operation ID, complete request, request digest
and target snapshot in the durable job. Each receipt is checked against that
identity. Completed target results remain in the ledger when later targets fail.
Lease expiry quarantines the job as `unknown`; it never makes it eligible for
another dispatch. Workers cannot persist progress after losing their lease.

`POST /api/v1/jobs/{id}/reconcile` requires scoped read, evidence and recovery
permissions. It returns a separate observation job ID. The original job remains
available at its original ID. Concurrent requests share an active observation
job; a later explicit request can create another bounded observation attempt.
Its five-minute deadline does not extend the original execution deadline.

The observer uses an already retained completed, ownership-released receipt or
receipt reads only. It does not request fresh capabilities,
reconstruct a request, retry dispatch, clear cancellation, or admit previously
unstarted targets. Receipt identity changes, missing retained operations, offline
dependencies and uncertain ownership remain visible as unknown outcomes.
Failure is terminal only when Magnus confirms ownership release. Successful
completion likewise requires the original completed receipt and released
ownership, followed by the request-specific result checks and ingestion.

If evidence ingestion completed before the result checkpoint was interrupted,
the observer reuses the exact retained terminal receipt, including its original
observation timestamp. It checks that receipt against the original request before
ingestion resumes. A later receipt envelope must not rewrite immutable evidence;
missing or unreleased receipts still require observation of the original operation.

Cancellation records intent. Only queued work with no retained external effect
is confirmed canceled locally. In-flight work remains subject to original
ownership and reconciliation; this protocol does not promise remote termination.
Reading a canceled operation's actual later completion preserves its cancellation
request and original deadline.

Evidence IDs are stable for one operation. Replaying an ingested observation
preserves later verification. A genuinely new observation uses new evidence IDs
and can reopen work while preserving historical verification.

Older incomplete ledgers may lack sufficient identity or target metadata.
They remain unknown rather than receiving invented completion evidence. Any new
assessment uses normal admission and a fresh operation identity. Native reboot
continuation and complete remote cancellation remain separate acceptance work.

Recommendation responses retain the durable jobs for their current plan revision,
including queued, running, failed and unknown work. Reading a job uses its request
scope rather than the wider scope of the principal that submitted it. An admitted
job is never hidden merely because dispatch stopped before an execution was
reserved; a new plan revision does not inherit the previous revision's job.

Operator review may outlast the cached target heartbeat. Host dispatch therefore
uses a fresh Magnus capability response for current enrollment, lifecycle,
heartbeat and action availability. It still requires the stored and current
execution identity, scope, environment, platform, managing agent, namespace and
container instance bindings to match. Changed bindings require inventory review;
a stale capability response or current offline target cannot authorize dispatch.

Historical operation reconciliation authorizes against the operation's original
plan revision and scope. A later, narrower revision cannot make an older wider
receipt readable. Recommendation and campaign-report execution/publication lists
refer to their current revision; earlier rows remain retained in authoritative
history and available only through access to their original scope.

Interrupted campaign jobs can use the same separate observation operation as
assessment jobs. The observer reads the original plan revision and every already
reserved action receipt. It cannot dispatch missing actions, query capabilities
for a new admission, renew authorization, resume a paused campaign or clear
cancellation. Only completed, ownership-released receipts for every original
action establish job completion. Application/security verification remains
independent of execution completion.

Artifact rollout admission requires a registered deployment/configuration binding,
a digest-qualified established artifact, immutable source revisions and retained
non-model build evidence matching the source commit, image reference and digest.
A model candidate or successful build message alone cannot supply this authority.

Fresh managed Compose inventory reconciles known digest-qualified artifacts to
separate container instances, host and managing-agent relationships. Replacement
or restart creates a distinct instance identity and preserves prior observations.
Unknown images, absent resources and changed configuration remain partial or not
assessed; an older observation cannot replace the newer deployment projection.
Inventory reconciliation never closes a security finding or verifies a build.

Concurrent native observations serialize their retained execution update. An older
running or unknown response cannot overwrite a completed ownership-released
receipt. Conflicting terminal facts are refused instead of silently rewriting
history; observation timestamps alone do not change immutable completion facts.

Deployment ordering uses native resource capture time, rather than the arrival
of a receipt envelope. Delayed delivery cannot make older inventory current.
Repeated observations preserve the existing relationship identity and its first
provenance; new evidence is retained as scoped corroboration observations.
Relationship reads and corroboration both check the original relationship scope,
even when its endpoints are visible more broadly.
