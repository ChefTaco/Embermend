# Embermend

Continuous hardening and vulnerability remediation for Magnus-managed
infrastructure and applications. Embermend owns security findings, revisioned
recommendations, authorization policies, and verified outcomes. Magnus owns
host enrollment, managed execution, resource ownership, and signed receipts.

The current release is **Embermend 0.3.3**; see the [changelog](CHANGELOG.md) for
what each release changed. All
AC-01–AC-24 reference acceptance journeys, recorded against 0.1.0, have retained
proof in the [acceptance ledger](docs/ACCEPTANCE.md), including native fault
recovery, the source-to-deployment workflow and combined-store restore.
The configured production suite has completed scoped assessment; Ubuntu coverage
remains explicitly partial. Production mutation policies stay disabled.
There is no standalone host-management mode or direct SSH execution path.

## Install

Use signed Hive 3.2.2 or a later compatible combination with Magnus 2.5.0 or newer
and its explicit Embermend bridge; Hive 3.12.3 pins Embermend 0.3.2 with Magnus 3.1.3.
In guided setup, opt into Embermend after selecting Magnus or configuring an existing
external Magnus. The default is off.

```sh
git clone https://github.com/ChefTaco/hive.git && cd hive
./hive.sh --release latest
```

Follow the [suite setup guide](https://github.com/ChefTaco/hive/blob/v3.12.3/deployment/EMBERMEND.md)
and [scoped operations guide](docs/OPERATIONS.md). Existing installations use their
own reviewed configuration, verified backup and restore rehearsal. Initial access
needs only `read`, `evidence` and `assess` on exact authorized targets.

## Develop

Use Node.js 24.22.3+ on the 24.x line or 26.13.1+ on the 26.x line, npm, and PostgreSQL.
Every workspace pins TypeScript **6.0.3** with strict typing,
`noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.

```sh
npm ci --ignore-scripts
npm run hooks:install
bash scripts/install-gitleaks.sh
npm run verify
```

For integration tests, set `DATABASE_URL` to an explicitly disposable loopback
database whose name begins with `embermend_test`, then run `npm run db:migrate`
and `npm run test:integration`. Integration tests delete their fixture records.
Never point them at product data. Prisma migration generation uses an explicit
`--output` file; verify the emitted SQL before applying it.

Configure the API and worker from `.env.example`; use environment injection or
Node's `--env-file` flag. Both processes share the same PostgreSQL database.

| Command | Process |
|---|---|
| `npm start` | API on `EMBERMEND_BIND`:`EMBERMEND_PORT` (default `127.0.0.1:4180`) |
| `npm run worker` | Durable work processing |
| `npm run inference` | Optional inference broker on `127.0.0.1:${EMBERMEND_INFERENCE_PORT:-4181}` ([provider guide](docs/INFERENCE.md)) |
| `node services/runtime/dist/index.js migrate` | Apply database migrations (`verify-initialization` checks them) |

`GET /health/live` reports process health and `GET /health/compatibility` the runtime and
bridge protocol; the authenticated `GET /api/v1/readiness` reports Magnus and inventory
readiness.

## Product boundaries

- Oathweave resource tokens identify callers. Explicit product grants restrict
  operations and applications/targets. Coordinator credentials cannot approve,
  edit policy, accept exceptions, or authorize recovery.
- Recommendations are published to the primary HiveXUI timeline before covered
  mutation. Delivery never implies approval. Standing policy can authorize an
  exact plan without requiring acknowledgement.
- Execution, source correction, deployment, security verification, operational
  health, and risk acceptance are separate facts. Unknown effects retain their
  original identities and require reconciliation.
- The custom TypeScript/JavaScript scanner parses actual source, indexes
  relationships, and invokes a configured model. Its conclusions start as
  candidates and require independent validation.
- Repository code runs only in an authorized isolated Magnus worker. Model
  brokers and credentialed provider writes remain outside that environment.
- Cindertrace, ChatterMost, HiveMem, and HiveSkills are optional integrations.

## Contracts and integration

The native versioned API is `/api/v1`. Hive ingress exposes the product under
`/api/embermend`; HiveXUI uses the authenticated product transport. Public Zod
contracts and [OpenAPI](packages/contracts/openapi.json) are product-owned.
Run `npm run openapi:write` after intentional contract/route changes. Export
browser contracts only from a committed source revision using
`scripts/export-browser-contracts.mjs`; HiveXUI verifies the retained hashes and
provenance. Restricted evidence additionally requires `evidence-restricted`;
ordinary evidence access never grants it.

`GET /api/v1/hive/events?after=<cursor>&limit=<n>` serves the Hive:Magnus
inbox feed: HiveEvent v1 records (from `@hivemagnus/hive-common`) derived from
committed audit rows, oldest first, for the last 14 days. It reports new
recommendations (`recommendation.created`, severity from the findings' own
severity and priority), decisions (`recommendation.approved`, `.rejected`,
`.policy-authorized`), campaign pauses, resumes and verification stops, and
failed or unknown execution outcomes (`execution.failed`,
`execution.needs-attention`). It applies the recommendation read rules: an
account without `read` gets 403, and records outside its scope are omitted.
Links point at HiveXUI's Embermend page. The Hive Registry announces it as
`"capabilities": { "events.v1": { "path": "/api/v1/hive/events" } }`.

`GET /api/v1/audit/export?after=<cursor>&limit=<n>` serves the suite audit
export that Cindertrace pulls: every committed audit row as a HiveAuditRecord v1
(`hiveAuditRecordSchema`), oldest first by `(createdAt, id)`, with opaque
cursors, `limit` from 1 to 200 (default 100) and no retention window. It
requires the permission **`embermend:audit:read`** (grant permission
`audit:read`). A service account (an `integration` or `coordinator` grant)
holding it exports every installation; an operator holding it exports only its
own installation. A token without it gets 403, and a missing token or one with
no product grant gets 401. Record IDs are `embermend:audit:<audit row id>`;
actions are the audit operations with hyphens as underscores (for example
`plan.approve`, `plan.policy_authorized`, `execution.receipt`); `outcome` is
`failure` for failed execution receipts and failed verifications. `details`
holds only flat identifiers, digests, revisions and states (plus the row's
`installationId`), redacted and at most 4 KB; operator-written text is omitted.
A collector grant looks like
`{"subject":"<collector client id>","kind":"integration","permissions":["audit:read"],"scope":{"installationId":"<installation>","applicationIds":[],"targetIds":[]}}`
in `EMBERMEND_IDENTITY_GRANTS`; its Oathweave client needs the
`embermend:audit:read` permission and the `embermend` audience.
Each page's `nextCursor` is the cursor of its last record, even on the final
page; it is `null` only when `data` is empty (caught up), so a collector keeps
its last non-null cursor and polls it again. `target` and `subject` are omitted
when empty. Oathweave signs client-credentials tokens with its native issuer by
default: set the optional comma-separated `OATHWEAVE_NATIVE_ISSUERS` (for
example Oathweave's `JWT_ISSUER`, such as `hive-iam`) to accept them. A
native-issuer token is accepted for service grants only, verified with the
hive-common Oathweave verifier against `OATHWEAVE_JWKS_URL`, and carries no
permission but `audit:read`, so it can use this route and nothing else.

The Ardent plugin is `@hivemagnus/embermend-ardent-plugin`. Configure
`EMBERMEND_URL` and a scoped `EMBERMEND_TOKEN` in the managed coordinator's
environment, then load the package through Ardent's plugin configuration.
No approval or policy-editing tools are exposed to the model.

## Security and publication

Never commit environment files, credentials, private infrastructure, source
captures, runtime data, or lab state. Hooks scan the exact staged index and
outgoing history with checksum-pinned Gitleaks. Do not bypass them.
Use the owning system's credential-invalidation evidence before closing an
exposed-secret occurrence; deleting the literal is insufficient.

## Documentation

- [Operations](docs/OPERATIONS.md): scoped operator access, operational observations and an
  optional unattended identity proposal
- [Inference providers](docs/INFERENCE.md): provider setup and CLI isolation
- [GitHub provider authorization](docs/GITHUB_PROVIDER_AUTH.md) and
  [provider boundaries](docs/PROVIDER_BOUNDARIES.md)
- [Artifact publication](docs/ARTIFACT_PUBLICATION.md) and [build tracking](docs/BUILD_TRACKING.md)
- [Recovery](docs/RECOVERY.md): managed job observation and cancellation
- [Reboot and deployment](docs/REBOOT_AND_DEPLOYMENT.md) and the
  [reboot fault matrix](docs/REBOOT_FAULT_MATRIX.md)
- [Releasing](docs/RELEASING.md), [implementation status](docs/IMPLEMENTATION_STATUS.md),
  [acceptance ledger](docs/ACCEPTANCE.md) and the
  [product specification](docs/PRODUCT_SPECIFICATION.md)

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
