import { entitySchema, evidenceSchema, type Actor, type Finding, type Verification } from '@hivemagnus/embermend-contracts';
import { within, type Transaction } from '@hivemagnus/embermend-store';
import { DomainError, requirePermission } from './authorization.js';

/** Live probes can establish mitigation; permanent image repair needs immutable artifact proof. */
export async function admitRuntimeArtifact(tx: Transaction, actor: Actor, finding: Finding, verification: Verification): Promise<void> {
  if (verification.dimension !== 'runtime' || verification.result !== 'pass' || !['code', 'dependency', 'image'].includes(finding.kind)) return;
  if (!verification.artifactDigest) throw new DomainError('CONTROLLING_ARTIFACT_REQUIRED');
  const row = await tx.entity.findUnique({ where: { stableKey: `artifact:${finding.scope.installationId}:${verification.artifactDigest}` } });
  const artifact = row ? entitySchema.parse(row.data) : null;
  if (!artifact || artifact.kind !== 'artifact' || artifact.provenance.assurance !== 'established') throw new DomainError('CONTROLLING_ARTIFACT_REQUIRED');
  requirePermission(actor, 'evidence', artifact.scope);
  const deployments = (await tx.entity.findMany({ where: { kind: 'deployment', installationId: finding.scope.installationId } })).map(item => entitySchema.parse(item.data));
  if (!deployments.some(item => item.kind === 'deployment' && item.targetIds.includes(verification.targetId) && item.artifactIds.includes(artifact.id) && within(actor.scope, item.scope) && (finding.kind !== 'code' || item.applicationId === finding.component))) throw new DomainError('CURRENT_CONTROLLING_ARTIFACT_BINDING_REQUIRED');
  for (const id of artifact.provenance.evidenceIds) {
    const evidenceRow = await tx.evidence.findUnique({ where: { id } }); if (!evidenceRow) continue;
    const evidence = evidenceSchema.parse(evidenceRow.data);
    if (!within(artifact.scope, evidence.scope) || evidence.subjectId !== artifact.id || evidence.source === 'ai-scanner' || evidence.content['artifactDigest'] !== artifact.digest || evidence.content['findingIdentity'] !== finding.identity || evidence.content['artifactSecurityCheckPassed'] !== true || evidence.content['immutableArtifactVerified'] !== true) continue;
    requirePermission(actor, 'evidence', evidence.scope); if (evidence.sensitivity === 'restricted') requirePermission(actor, 'evidence-restricted', evidence.scope);
    return;
  }
  throw new DomainError('CONTROLLING_ARTIFACT_SECURITY_EVIDENCE_REQUIRED');
}
