import { buildSchema, entitySchema, evidenceSchema, type Action, type Plan } from '@hivemagnus/embermend-contracts';
import { within, type Transaction } from '@hivemagnus/embermend-store';
import { type PublicationDescriptor } from '@hivemagnus/embermend-integrations';
import { DomainError } from './authorization.js';

export async function admitPublication(tx: Transaction, plan: Plan, action: Action, expected: PublicationDescriptor): Promise<void> {
  const branch = action.preconditions['branch']; if (typeof branch !== 'string') throw new DomainError('PUBLICATION_SOURCE_BRANCH_REQUIRED');
  if (action.version !== 'artifact-publish.v1' || action.parameters['artifactId'] !== expected.artifactId || action.parameters['digest'] !== expected.artifactDigest || action.parameters['destinationId'] !== expected.destinationId) throw new DomainError('PUBLICATION_PARAMETERS_CHANGED');
  const row = await tx.entity.findUnique({ where: { id: expected.artifactId } }); const artifact = row ? entitySchema.parse(row.data) : null;
  if (!artifact || artifact.kind !== 'artifact' || !within(plan.scope, artifact.scope) || artifact.digest !== expected.artifactDigest || artifact.image !== expected.imageRef || artifact.provenance.assurance !== 'established' || !artifact.provenance.evidenceIds.includes(expected.reviewEvidenceId) || !plan.evidenceIds.includes(expected.reviewEvidenceId) || !artifact.buildRunId) throw new DomainError('REVIEWED_PUBLICATION_ARTIFACT_REQUIRED');
  const proofRow = await tx.evidence.findUnique({ where: { id: expected.reviewEvidenceId } }); const proof = proofRow ? evidenceSchema.parse(proofRow.data) : null;
  if (!proof || !within(plan.scope, proof.scope) || proof.source === 'ai-scanner' || proof.subjectId !== artifact.id || proof.content['archiveDigest'] !== expected.archiveDigest || proof.content['artifactDigest'] !== artifact.digest || proof.content['imageRef'] !== artifact.image || proof.content['buildVerified'] !== true || proof.content['attestationVerified'] !== true) throw new DomainError('VERIFIED_PUBLICATION_ATTESTATION_REQUIRED');
  const sourceCommits: string[] = [];
  for (const id of artifact.sourceRevisionIds) {
    const sourceRow = await tx.entity.findUnique({ where: { id } }); const source = sourceRow ? entitySchema.parse(sourceRow.data) : null;
    if (!source || source.kind !== 'source-revision' || !within(plan.scope, source.scope) || source.repositoryId !== action.targetId || source.branch !== branch || proof.content['sourceCommit'] !== source.commit || action.expectedRevision !== source.commit) throw new DomainError('PUBLICATION_SOURCE_IDENTITY_CHANGED');
    sourceCommits.push(source.commit);
  }
  if (!sourceCommits.length || JSON.stringify([...new Set(sourceCommits)].sort()) !== JSON.stringify([...new Set(expected.sourceCommits)].sort())) throw new DomainError('PUBLICATION_SOURCE_IDENTITY_CHANGED');
  const buildRow = await tx.build.findUnique({ where: { id: artifact.buildRunId } }); const build = buildRow ? buildSchema.parse(buildRow.data) : null;
  if (!build || !within(plan.scope, build.scope) || build.repositoryId !== action.targetId || !artifact.sourceRevisionIds.includes(build.sourceRevisionId) || !sourceCommits.includes(build.sourceCommit) || build.status !== 'completed' || build.conclusion !== 'success' || proof.content['providerRunId'] !== build.providerRunId || proof.content['runAttempt'] !== build.runAttempt) throw new DomainError('SUCCESSFUL_PUBLICATION_BUILD_REQUIRED');
  const bindings = (await tx.entity.findMany({ where: { kind: 'source-binding', installationId: plan.scope.installationId } })).map(item => entitySchema.parse(item.data)).filter(item => item.kind === 'source-binding' && item.repositoryId === action.targetId && item.applicationId === build.applicationId && within(plan.scope, item.scope) && item.maintainedBranches.includes(branch) && item.buildDefinitions.includes(build.workflowPath));
  if (bindings.length !== 1) throw new DomainError('PUBLICATION_SOURCE_POLICY_CHANGED');
}
