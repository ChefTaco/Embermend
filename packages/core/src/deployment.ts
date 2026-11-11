import { entitySchema, evidenceSchema, type Action, type Plan } from '@hivemagnus/embermend-contracts';
import { within, type Transaction } from '@hivemagnus/embermend-store';
import { DomainError } from './authorization.js';

/** A digest approval cannot invent a deployment or establish artifact provenance. */
export async function admitDeployment(tx: Transaction, plan: Plan, action: Action): Promise<void> {
  if (action.version !== 'compose-deploy.v1') return;
  const deploymentId = action.parameters['deploymentId']; const artifactDigest = action.parameters['artifactDigest'];
  if (typeof deploymentId !== 'string' || typeof artifactDigest !== 'string') throw new DomainError('DEPLOYMENT_PARAMETERS_REQUIRED');
  const row = await tx.entity.findUnique({ where: { id: deploymentId } });
  const deployment = row ? entitySchema.parse(row.data) : null;
  if (!deployment || deployment.kind !== 'deployment' || !within(plan.scope, deployment.scope) || !deployment.targetIds.includes(action.targetId) || deployment.configurationDigest !== action.parameters['configurationDigest']) throw new DomainError('DEPLOYMENT_BINDING_OR_CONFIGURATION_CHANGED');
  const artifactRow = await tx.entity.findUnique({ where: { stableKey: `artifact:${plan.scope.installationId}:${artifactDigest}` } });
  const artifact = artifactRow ? entitySchema.parse(artifactRow.data) : null;
  if (!artifact || artifact.kind !== 'artifact' || !within(plan.scope, artifact.scope) || artifact.digest !== artifactDigest || !artifact.image?.endsWith('@sha256:' + artifactDigest) || artifact.provenance.assurance !== 'established' || !artifact.sourceRevisionIds.length) throw new DomainError('ESTABLISHED_ARTIFACT_PROVENANCE_REQUIRED');
  for (const id of artifact.sourceRevisionIds) {
    const sourceRow = await tx.entity.findUnique({ where: { id } }); const source = sourceRow ? entitySchema.parse(sourceRow.data) : null;
    if (!source || source.kind !== 'source-revision' || !within(plan.scope, source.scope)) throw new DomainError('ARTIFACT_SOURCE_REVISION_REQUIRED');
    let verified = false;
    for (const evidenceId of artifact.provenance.evidenceIds) {
      const evidenceRow = await tx.evidence.findUnique({ where: { id: evidenceId } }); const evidence = evidenceRow ? evidenceSchema.parse(evidenceRow.data) : null;
      if (evidence && within(plan.scope, evidence.scope) && evidence.subjectId === artifact.id && evidence.source !== 'ai-scanner' && evidence.content['artifactDigest'] === artifactDigest && evidence.content['imageRef'] === artifact.image && evidence.content['sourceCommit'] === source.commit && evidence.content['buildVerified'] === true) verified = true;
    }
    if (!verified) throw new DomainError('ARTIFACT_BUILD_EVIDENCE_REQUIRED');
  }
}
