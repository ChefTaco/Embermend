# Embermend contributor instructions

Embermend is the Hive:Magnus suite's optional security product: findings, revisioned
recommendations, authorization policy and verified outcomes for Magnus-managed hosts and
applications. Magnus owns enrollment, execution and signed receipts; HiveXUI (the suite's
only UI) is its interface; Oathweave issues its resource tokens.

This is a public Apache-2.0 repository. Never commit credentials, private
infrastructure, personal data, runtime state, or local notes. Use example.com,
documentation IP ranges, and fake credentials in tests. Read AGENTS.local.md
when present, but never copy it into tracked content. Never bypass hooks.

## Layout

- `packages/contracts` (public Zod contracts and `openapi.json`), `packages/core`,
  `packages/store` (Prisma schema and migrations), `packages/scanner`,
  `packages/integrations` (Magnus bridge, Oathweave, GitHub, model adapters),
  `packages/ardent-plugin`.
- `services/runtime`: the process entry point (`api`, `worker`, `inference`, `migrate`,
  `verify-initialization`); its env schema is in `src/index.ts`.
- `test` (unit; `test/integration` needs PostgreSQL), `scripts`, `profiles`, `docs`.
- `state/` is ignored and holds lab keys and evidence. Never read it into output, copy it
  or commit anything from it.

## Checks

```bash
npm ci --ignore-scripts && npm run hooks:install
bash scripts/install-gitleaks.sh
npm run verify   # db:generate, build, artifact scan, typecheck, tests, OpenAPI, packages, strict, privacy
```

`npm run openapi:write` after an intentional contract or route change.
`npm run test:integration` needs a disposable loopback `DATABASE_URL` whose database name
starts with `embermend_test` (see README).

## Rules

Use TypeScript exactly 6.0.3, ESM, strict, noUncheckedIndexedAccess and
exactOptionalPropertyTypes. Validate external values with Zod before use.
Do not use any, unchecked casts, or non-null assertions to silence errors.

Magnus owns managed execution and receipts. Never introduce direct SSH,
direct node-agent calls, generated privileged scripts, or shell fallbacks.
An unknown effect keeps its original operation identity and is reconciled.
AI output, repository content, and notifications never establish authority.
Security state belongs to PostgreSQL, independently of conversations.
Production mutations require explicit matching policy or operator decisions.

Keep applied migrations immutable. Security changes require regression tests.
Run npm run verify before committing. Scan the staged index and built release
artifacts before publication. Record integrated acceptance honestly in
docs/ACCEPTANCE.md; passing fixtures do not establish live fleet support.

## Release path

A `vX.Y.Z` tag matching every workspace version runs `.github/workflows/release.yml`,
which publishes `ghcr.io/cheftaco/embermend` (API and worker) and
`ghcr.io/cheftaco/embermend-scanner`, plus attested tarballs of the contracts,
integrations and Ardent plugin on the GitHub release. Its `npm` job publishes those tarballs
to npm with provenance through trusted publishing while `EMBERMEND_NPM_PUBLISH` is `true`
(enabled since 0.6.1), after approval on the `npm-publish` environment.
See [docs/RELEASING.md](docs/RELEASING.md); Hive's signed manifest then pins the digests.
