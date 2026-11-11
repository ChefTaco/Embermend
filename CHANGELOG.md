# Changelog

## Unreleased

- Require patched Node.js 24.22.3 or 26.13.1, update builder and CI pins, and upgrade Hono to 4.13.18 for bounded memory when requests arrive in tiny transfer chunks (GHSA-39q9-qp46-w8xg).

- Preserve resource scope across identity reconciliation, policy/plan revisions and campaign membership; serialize finding IDs and require review when a match changes component or classification.

- Consume the suite's released Ardent 3.0.0 plugin API and shared Node runtime image.

- Establish strict TypeScript 6.0.3 workspaces, product contracts, PostgreSQL
  state, authorization, durable jobs, evidence, and verification boundaries.
- Add the custom source-analysis scanner and typed Ardent coordinator plugin.
- Add managed Magnus execution, versioned posture profiles, vendor OVAL/Trivy
  adapters, bounded provider operations and the compact HiveXUI integration.
- Require branch/component-bound source verification, restricted-evidence access,
  exact displayed revisions, authoritative environment checks and independent
  effective-state evidence.
- Retain partial disposable-host and PostgreSQL restore evidence; no release or
  production automation is enabled.

This development record does not establish integrated product acceptance.
