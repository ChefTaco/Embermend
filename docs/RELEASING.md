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

### npm

The release workflow's `npm` job publishes the same three attested tarballs to npm as
`@hivemagnus/embermend-contracts`, `-integrations` and `-ardent-plugin`, with provenance,
through npm trusted publishing (OIDC; no npm token is stored). It runs only when the
repository variable `EMBERMEND_NPM_PUBLISH` is `true`, waits for approval on the
`npm-publish` environment and refuses to run unless that environment has a required
reviewer. A version already on npm is skipped. It is enabled (since 0.6.0): the variable is
`true` and the three packages have trusted publishers. To set it up from scratch, an owner of
the `@hivemagnus` npm organization:

1. Publishes each package once by hand, because npm configures a trusted publisher only for
   an existing package: download and verify a release as above, then
   `npm publish ./release-assets/hivemagnus-embermend-<name>-X.Y.Z.tgz --access public` for
   `contracts`, then `integrations`, then `ardent-plugin`.
2. On npmjs.com, for each package, opens Settings > Trusted publishing, chooses GitHub
   Actions and enters organization or user `ChefTaco`, repository `Embermend`, workflow
   filename `release.yml` and environment `npm-publish`. Optionally sets Publishing access to
   "Require two-factor authentication and disallow tokens".
3. In GitHub, Settings > Environments, creates `npm-publish` with at least one required
   reviewer and deployment tags limited to `v*`.
4. In GitHub, Settings > Secrets and variables > Actions > Variables, adds
   `EMBERMEND_NPM_PUBLISH` = `true`.

The next `vX.Y.Z` tag then publishes after the GitHub release, once a reviewer approves.

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

After profile setup, reduce runtime grants to the intended operating scope.
Environment-file edits do not change an existing container's effective environment.
Apply the owning installer's configuration change so it recreates the API and
worker, then verify both loaded grants and the absence of enabled mutation policies.
A container or host restart alone does not reload Compose environment-file values.
