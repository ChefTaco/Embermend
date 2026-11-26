# Embermend integrations

Backend adapters for the constrained Magnus bridge, Oathweave resource identity,
scoped resource-token providers, bounded GitHub operations, model invocation and
dated threat feeds. Credentials are supplied by the owning protected service.
Never put this package or its credentials inside repository execution or browser
bundles. The browser surface uses the public contracts package instead.

Adapters retain original operation identities and distinguish unknown outcomes
from confirmed failure. The package is released with Embermend as an attested GitHub
release tarball (on npm once trusted publishing is enabled). It does not by itself establish complete
live-provider or remediation acceptance.
