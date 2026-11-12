# GitHub Actions build observations

`POST /api/v1/build-observations` accepts a durable observation job. Supply its
unique request ID, scope, registered repository/application/source revision,
provider run ID, exact attempt, workflow ID/path and deadline. Inspect and cancel
it through the normal job endpoints. `GET /api/v1/builds` and the Ardent
`embermend_builds` tool expose scoped results. `embermend_observe_build` requests
an observation; it cannot start or rerun a workflow.

The principal needs `read`, `evidence` and `assess` in the requested scope.
The source binding must explicitly allow the workflow definition and source
branch. The provider grant independently permits that workflow and branch.
Provider reads verify the repository identity, source repository, exact commit,
branch, workflow, attempt and canonical run URL. A fork or changed identity is
refused. Results cannot establish artifact provenance, create artifacts, close
findings, publish images or deploy them.

Attempts have separate persistent identities and append-only evidence. Older
provider responses cannot replace newer state. A terminal attempt cannot change
its conclusion. Cancellation and expired worker leases prevent result writes.
A separate operator with `read`, `evidence` and `recover` can reconcile an unknown
observation using only provider GETs, preserving the original deadline and
cancellation intent. A provider outage does not invalidate retained build facts.

## Authentication requirements

This path uses only repository metadata and workflow-attempt reads. GitHub
documents Actions repository read permission for a fine-grained token; a
classic token uses `repo` for private repositories. Public runs can also be read
without authentication. Existing authentication can be used when these reads
succeed. A repository ADMIN role alone neither prevents nor authorizes product
operations; Embermend still enforces its own scopes and provider allowlists.
See [GitHub's workflow-run API](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10).

A separate runtime identity is useful when continuous service operation requires
credentials independent of the interactive operator. Its concrete ceiling for
this feature is metadata plus Actions read on selected repositories. Workflow
dispatch, tag/branch writes, merges and package publication are separate future
authorities. Never copy a provider credential into a repository worker, build
context, image layer, source tree or public evidence record.

## Limits

This endpoint tracks an existing workflow attempt. It cannot dispatch a build.
Artifact retrieval and cryptographic verification remain trusted operator import
steps; [reviewed OCI publication](ARTIFACT_PUBLICATION.md) has a separate provider
path and authorization. The acceptance ledger records which isolated builds,
signed artifacts and deployment journeys have actual retained proof.
Successful CI is evidence about that workflow, not proof that it built the
approved artifact or repaired a security defect.
