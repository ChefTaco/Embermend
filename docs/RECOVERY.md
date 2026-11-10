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

The observer uses receipt reads only. It does not request fresh capabilities,
reconstruct a request, retry dispatch, clear cancellation, or admit previously
unstarted targets. Receipt identity changes, missing retained operations, offline
dependencies and uncertain ownership remain visible as unknown outcomes.
Failure is terminal only when Magnus confirms ownership release. Successful
completion likewise requires the original completed receipt and released
ownership, followed by the request-specific result checks and ingestion.

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
