# Releasing Embermend

Retain the acceptance ledger, current combined-suite restore proof and the owning
repositories' checks before production adoption. Publish the compatible Magnus
bridge first. Embermend requires Magnus 2.5.0 or newer declaring managed bridge
protocol 1, Oathweave browser bootstrap and the HiveXUI operator module.

## Versioned artifacts

The `vX.Y.Z` tag must exactly match every Embermend workspace version. The release
workflow runs the compiler, PostgreSQL, contract, privacy and container gates
before building on native Linux amd64 and arm64 runners. Each runtime is executed
under its non-root identity and its scanner/source/preparation protocols are
tested. Every HIGH and CRITICAL vulnerability, including unfixed findings, blocks
publication of a version tag. Unfiltered reports are retained.

API and worker use `ghcr.io/cheftaco/embermend:X.Y.Z` with separate `api` and
`worker` commands. The isolated scanner uses
`ghcr.io/cheftaco/embermend-scanner:X.Y.Z`. Published platform configurations must
match the actual candidates that passed execution and vulnerability checks.
Both indexes retain SBOMs, build provenance and GitHub attestations. Existing
version tags are never overwritten.

The GitHub release also contains `compatibility.json`, immutable image references,
checksums and attested tarballs for the public contracts, integrations and Ardent
plugin. Install those three tarballs together in the coordinator's trusted plugin
installation. Model/provider credentials stay outside executed repository code.

```bash
gh release download vX.Y.Z --repo ChefTaco/Embermend --dir release-assets
(cd release-assets && sha256sum --check SHA256SUMS)
for package in release-assets/*.tgz; do
  gh attestation verify "$package" --repo ChefTaco/Embermend
done
npm install ./release-assets/*.tgz
```

Image verification uses the retained digest rather than the mutable locator:

```bash
gh attestation verify oci://ghcr.io/cheftaco/embermend@sha256:DIGEST \
  --repo ChefTaco/Embermend
```

Use the compatibility metadata and verified image digests in a new signed Hive
release. Exercise its installer selection, initialization, scoped identity,
ingress, Registry records, backup and isolated restore. Previous signed release
bytes remain immutable. A production installation starts with empty target and
application grants; inventory/assessment scope is added through reviewed setup.
Production mutations require a subsequent explicit matching decision or policy.
