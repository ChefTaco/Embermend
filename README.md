# Embermend

Continuous hardening and vulnerability remediation for Magnus-managed
infrastructure and applications. Embermend owns security findings, revisioned
recommendations, authorization policies, and verified outcomes. Magnus owns
host enrollment, managed execution, resource ownership, and signed receipts.

**Embermend 0.2.0 is released.** It adds the Hive:Magnus event feed. All
AC-01–AC-24 reference acceptance journeys, recorded against 0.1.0, have retained
proof in the [acceptance ledger](docs/ACCEPTANCE.md), including native fault
recovery, the source-to-deployment workflow and combined-store restore.
The configured production suite has completed scoped assessment; Ubuntu coverage
remains explicitly partial. Production mutation policies stay disabled.
There is no standalone host-management mode or direct SSH execution path.

## Install

Use signed Hive 3.2.2 or a later compatible combination with Magnus 2.5.0 or newer
and its explicit Embermend bridge. In guided setup, opt into Embermend after
selecting Magnus or configuring an existing external Magnus. The default is off.

```sh
git clone https://github.com/ChefTaco/hive.git && cd hive
./hive.sh --release latest
```

Follow the [suite setup guide](https://github.com/ChefTaco/hive/blob/v3.2.2/deployment/EMBERMEND.md)
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
`npm start` starts the API; `npm run worker` starts durable work processing.
Live and readiness endpoints distinguish process health from Magnus readiness.

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

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Inference setup and CLI isolation are described in [the provider guide](docs/INFERENCE.md).
GitHub permissions, merge enforcement and the optional unattended App setup are
described in [provider authorization](docs/GITHUB_PROVIDER_AUTH.md).
Managed job observation and cancellation semantics are documented in
[recovery](docs/RECOVERY.md).

Scoped operator access, operational observations and a concrete optional unattended
identity proposal are described in [operations](docs/OPERATIONS.md).
