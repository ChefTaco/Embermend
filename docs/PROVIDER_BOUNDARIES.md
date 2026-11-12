# GitHub provider boundary

Provider grants name a stable numeric repository identity, approved current
owner/name, maintained base branches and workflows. Repository transfer or
rename requires an explicit access review while retaining the product identity.
Provider credentials stay outside repository execution.

Pull-request merge requires the exact authorized head, a complete bounded set
of passing check runs, and GitHub's live mergeability and review decision.
Blocked, unknown, draft, outdated and incomplete states stop execution. An
administrator role neither authorizes nor disqualifies a credential. The adapter
checks its actual provider access, product permissions and current repository
rules. A final head/base read
precedes the SHA-bound merge request; the provider continues enforcing its rules.
The adapter never changes protection settings. GitHub documents these states in
[its GraphQL reference](https://docs.github.com/en/graphql/reference/pulls) and
[protected-branch guidance](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

Prepared tree, commit, dedicated branch, pull request and merge are separately
retained provider phases. A lost provider reply remains unknown. Complete
provider reconciliation and live GitHub acceptance have separate retained proof;
fixture tests alone cannot establish those capabilities. Read-only build tracking
retains exact workflow attempts. [Reviewed artifact publication](ARTIFACT_PUBLICATION.md)
uses its own permission, decision, immutable build/attestation evidence and exact
registry destination, outside executed repository code. Deployment remains a
separate Magnus-managed action. The full release and installation gates remain
documented in the acceptance ledger.
