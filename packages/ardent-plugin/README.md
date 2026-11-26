# Embermend Ardent plugin

Load this package through Ardent's reviewed plugin configuration. Set
`EMBERMEND_URL` to the verified HTTPS product endpoint and use the managed
coordinator's scoped Oathweave resource-token provider:
`EMBERMEND_OAUTH_TOKEN_URL`, `EMBERMEND_OAUTH_CLIENT_ID` and
`EMBERMEND_OAUTH_CLIENT_SECRET`. A short-lived `EMBERMEND_TOKEN` is available
for explicitly managed resource-token injection.

The plugin reads scoped inventory/evidence, the recommendations timeline
(`embermend_recommendations`, paged with `nextCursor`) and readiness with its blockers
(`embermend_readiness`), requests host, vulnerability (`embermend_assess_vulnerabilities`)
and isolated preparation work, can ask to cancel a job (`embermend_job_cancel`), proposes structured recommendations, publishes explanations, asks
for deterministic standing-policy evaluation and follows already authorized
work. Its tools cannot approve a plan, change policy, accept an exception or
authorize recovery. The product rechecks permissions and exact plan revisions.
The default OAuth scope matches the suite's read/assessment/preparation ceiling.
`EMBERMEND_OAUTH_SCOPE` can request a reviewed subset of the coordinator's
actual grant, including execution permissions after separate authorization.
Approval, policy, exception and recovery scopes are refused. Credentials never
enter scanned repository code. Publication and execution stay
separate operations. Configure only the permissions actually granted to the
coordinator; enabling tools cannot expand its server-side authority.

A refused request fails with Embermend's own error code as the tool result's `code`
(`SCOPE_OR_PERMISSION_DENIED`, `PLAN_CHANGED`, `TARGET_NOT_ELIGIBLE` and so on; `HTTP_<status>`
when the body names none) and a message `EMBERMEND_HTTP_<status>_<code>`. Only constant-style
codes are passed on, never response text. A 401 drops the cached resource token. Reconciling
an unknown job needs the operator-only `recover` permission, so it has no tool here.

The package is released with Embermend as an attested tarball on each GitHub release, and
on npm with provenance once trusted publishing is enabled; see [releasing](../../docs/RELEASING.md). Its acceptance scope is in
the [acceptance ledger](../../docs/ACCEPTANCE.md).

The endpoint may be a native service origin or the Hive ingress prefix
`https://suite.example.com/api/embermend`. Tool requests preserve that prefix.
List tools return named object envelopes (`findings`, `entities`, `policies`)
so Ardent's evidence recorder can retain them during actual model tasks.
