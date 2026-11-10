# Contributing

Use TypeScript exactly **6.0.3**, strict typing, ESM, and the supported Node.js
runtime. Validate external values as `unknown`. Keep all new and modified code
free of unexplained `any`, non-null assertions, and unchecked casts.

Install dependencies with `npm ci --ignore-scripts`, install the repository
hooks with `npm run hooks:install`, and run `npm run verify`. PostgreSQL tests
also require the explicitly disposable database described in the README.
Security behavior changes need a meaningful regression test. Keep applied
migrations immutable and retain independent evidence for operational claims.

Do not add host agents, arbitrary-shell handlers, direct SSH fallbacks, or
provider credentials in repository execution. Magnus owns execution admission
and receipts. Unknown effects must keep their original identity.

Before a contribution, read [AGENTS.md](AGENTS.md), [SECURITY.md](SECURITY.md),
and the [acceptance ledger](docs/ACCEPTANCE.md). Describe the concrete behavior,
validation, and remaining acceptance limits. Fixture tests, synthetic browser
screens and development images do not establish product acceptance.

Never publish credentials, private infrastructure, runtime data, source
captures, personal data, or local notes. Do not bypass privacy hooks.
