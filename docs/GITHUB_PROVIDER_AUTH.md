# GitHub provider authorization

A repository role and a credential's API permissions answer different questions.
An `ADMIN` repository role is not a reason to reject an otherwise authorized
operation. Nor does a `WRITE` role establish that a token can perform that
operation or that the actor lacks rule-bypass privileges.

Embermend uses an exact repository-ID/owner/name grant, permitted base branches
and workflow IDs, and separate product permissions for repository writing,
merge, build dispatch and deployment. Credentials stay in the provider broker.
They never enter repository containers or model context.

| Operation | GitHub App repository permission |
|---|---|
| Repository identity and source reads | Metadata read; Contents read for private source |
| Create patch trees, commits and remediation branches | Contents write |
| Open and inspect a remediation PR | Pull requests write |
| Inspect check runs | Checks read |
| Track workflow runs | Actions read |
| Explicitly dispatch an approved workflow | Actions write, only when this feature is enabled |
| Request an approved merge | Contents write, with all repository rules satisfied |

Writing workflow definitions is outside the baseline grant. Publishing packages,
changing repository administration, editing secrets and deploying are not
implicit permissions of this integration. Product-side approval remains
necessary even when a provider token has sufficient permissions.

References: [Git trees](https://docs.github.com/en/rest/git/trees#create-a-tree),
[pull requests and merge](https://docs.github.com/en/rest/pulls/pulls),
[check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference),
[workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

## Merge enforcement

The broker validates the approved PR head, allowed base, complete passing check
results and GitHub's merge/review readiness. It uses the asynchronous merge API
with the exact head SHA, `merge_action: "default"` and `bypass_rules: false`.
This preserves a configured merge queue and does not request an administrator
exception. Unknown or blocked readiness stops admission regardless of role.
No legacy bypass-capable fallback is selected if this API is unsupported.

An accepted request retains its provider UUID and stays pending. Queue admission
is not a merged commit. Reconciliation reads the retained request and PR, checks
the approved head again, and records completion only with matching merge
commit evidence. It never submits another request while observing that outcome.
Separately authorized source verification is still required after a merge.
[GitHub asynchronous merge contract](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously).

## Existing operator authentication

Existing GitHub CLI authentication can support authorized local implementation
and acceptance when its token scopes and repository access cover these calls.
It does not need to be replaced because its user has an administrator role.
Check token scopes, selected repository access and actual API responses instead
of deriving token permissions from `viewerPermission`.

Classic/OAuth `repo` authorization covers repository operations, and GitHub
requires `repo` for workflow dispatch with those token types. A `workflow` scope
is relevant to editing workflow definitions, not a requirement to run every
existing workflow. Do not broaden a credential automatically after a refusal.
[OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps),
[dispatch authorization](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

## Optional identity for an unattended deployment

A dedicated GitHub App is a deployment option for smaller credential scope,
independent revocation and expiring installation tokens. It is not required to
continue local acceptance with sufficient existing authentication.

A concrete deployment setup is:

1. Install one Embermend provider App on explicitly selected repositories.
   Grant Metadata read, Contents write, Pull requests write, Checks read and
   Actions read. Add Actions write only for approved workflow dispatch.
2. Grant no repository Administration write, Secrets, Workflows write, package
   publication or rule-bypass allowance. Keep branch protections and rulesets
   under the maintainer's control.
3. Keep the App key in a protected provider-broker secret reference. Implement
   installation-token renewal outside repository execution, restricted to the
   configured repository IDs and permission subset. Do not copy an operator's
   CLI credential store into an API or worker image.
4. Configure the installation's exact repository IDs, owners, allowed base
   branches and workflow IDs in the provider grants. Incoming API users and
   machine clients independently use Oathweave's `embermend` audience and scoped
   product permissions. Start with reads and isolated preparation; provider
   writing, merge and deployment remain separate grants.

The current static-token adapter still needs an installation-token renewal
provider before this optional App setup becomes an unattended deployment path.
No App is registered, credential rotated, permission widened or protection
changed merely by documenting this option.
