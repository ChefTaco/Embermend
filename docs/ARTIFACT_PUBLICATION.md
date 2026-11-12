# Reviewed OCI artifact publication

The optional registry publisher runs inside the trusted API/worker runtime,
separately from executed repository code. Configure `EMBERMEND_PUBLICATION_CONFIG`
with a protected JSON file and mount its reviewed OCI layouts read-only into both
processes. No provider credential or layout mount enters a repository sandbox.
Absence of this configuration blocks publication without disabling assessment.

A trusted operator first downloads the exact successful build artifact, verifies
its cryptographic attestation against the approved repository, immutable commit,
workflow and attempt, and inspects its OCI graph, platform images, provenance and
SBOMs. Retain the archive digest and verification evidence. A successful workflow
conclusion alone cannot establish these facts. The runtime enforces this reviewed
catalogue; it does not replace cryptographic verification during artifact import.

Configuration has `artifacts` and `destinations` arrays. Each artifact specifies
`artifactId`, `artifactDigest` (the OCI index SHA-256), `sourceCommits`,
`reviewEvidenceId`, `archiveDigest` and an absolute `layoutPath`. Each destination
specifies `id`, `origin` and `repository`, plus an optional `imageHost` when managed
pulls use a different registry address. An optional `tokenEnv` names an existing
protected registry credential. HTTPS is required except for explicit loopback
HTTP registries used in disposable testing. Configuration cannot come from the
repository or scanner output.

Use `artifact-publish.v1` with a repository target, the `artifact-publish` action
class, and exact `artifactId`, `digest` and `destinationId` parameters. Bind the
maintained source commit in `expectedRevision`, and its branch and environment
in preconditions. The plan must include the immutable review evidence. That
non-model evidence must establish `attestationVerified`, `buildVerified`,
`archiveDigest`, `artifactDigest`, `imageRef`, `sourceCommit`, `providerRunId` and
`runAttempt`. The artifact must reference the successful retained build attempt
and source revision. Current source policy and provider head are rechecked before
each admitted effect.

Publication requires its own scoped permission, durable HiveXUI explanation and
matching explicit decision or standing policy. Branch writing, merge approval
and deployment approval do not grant it. The catalogue, artifact, source, build,
evidence, destination and authorization must continue to match at dispatch.

The publisher checks canonical ordinary files, object sizes and SHA-256 values
before reserving a provider effect. It copies the original blobs and manifests,
including attestation manifests, without conversion or mutable tags. Upload
responses cannot redirect credentials outside the configured destination. The
root index is published last. Completion retains the exact image reference as its
provider operation identity; findings remain unchanged.

A lost response retains the original execution and phase. Reconciliation uses
only digest-bound registry reads and validates manifest bytes and referenced
objects. Missing or incomplete publication stays unknown; it cannot authorize
another write. Cancellation, expiry or revocation do not prevent observing the
original effect. Deployment remains a separate Magnus-managed operation with
its own permission, decision, resource binding and independent verification.
