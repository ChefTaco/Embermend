# Embermend

Continuous hardening and vulnerability remediation for Magnus-managed
infrastructure and applications. Embermend owns security findings, revisioned
recommendations, authorization policies, and verified outcomes. Magnus owns
host enrollment, managed execution, resource ownership, and signed receipts.

**Development preview.** Product completion requires all acceptance criteria in
[the specification](docs/PRODUCT_SPECIFICATION.md). See
[acceptance status](docs/ACCEPTANCE.md) before enabling or claiming a capability.
There is no standalone host-management mode or direct SSH execution path.

## Develop

Use Node.js 24.22.1 or a supported Node.js 26 release, npm, and PostgreSQL.
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
