# Embermend contributor instructions

This is a public Apache-2.0 repository. Never commit credentials, private
infrastructure, personal data, runtime state, or local notes. Use example.com,
documentation IP ranges, and fake credentials in tests. Read AGENTS.local.md
when present, but never copy it into tracked content. Never bypass hooks.

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
