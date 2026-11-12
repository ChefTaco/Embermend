# Embermend Ardent plugin

Load this package through Ardent's reviewed plugin configuration. Set
`EMBERMEND_URL` to the verified HTTPS product endpoint and use the managed
coordinator's scoped Oathweave resource-token provider:
`EMBERMEND_OAUTH_TOKEN_URL`, `EMBERMEND_OAUTH_CLIENT_ID` and
`EMBERMEND_OAUTH_CLIENT_SECRET`. A short-lived `EMBERMEND_TOKEN` is available
for explicitly managed resource-token injection.

The plugin reads scoped inventory/evidence, requests assessment and isolated
preparation, proposes structured recommendations, publishes explanations, asks
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

This is a development preview, pending the full product acceptance ledger.

The endpoint may be a native service origin or the Hive ingress prefix
`https://suite.example.com/api/embermend`. Tool requests preserve that prefix.
List tools return named object envelopes (`findings`, `entities`, `policies`)
so Ardent's evidence recorder can retain them during actual model tasks.
