# Disposable acceptance laboratory

The lab uses official Ubuntu 24.04 cloud images verified against the publisher's
SHA-256 list, KVM guests, an isolated PostgreSQL/Redis control plane, a private
short-lived CA, and actual Magnus enrollment and managed receipts.

Provision prerequisites before starting the one-way enrollment drain. Never
change a drained host through an administrative bootstrap shortcut. Preserve
blocked enrollment evidence and replace a disposable candidate when its agent
or prerequisites must change. Inspection is read only. Product effects always
cross the endpoint-scoped Magnus bridge; SSH is not a product execution path.

Rootless repository workers use dedicated accounts and immutable scanner images.
They receive no node, provider-write, management, or model credentials. Public
repository fetch and credentialed model/provider brokers stay outside repository
execution. A fixture model or a mocked receipt does not establish integrated
scanner or mutation acceptance.

Keep operational keys, disks, model references, endpoint credentials, raw traces,
and retained acceptance evidence under ignored `state/`. Record only sanitized
outcomes and evidence digests in the public acceptance ledger. Do not publish
controlled vulnerable images as product release images.
