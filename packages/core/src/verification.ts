import { type Finding, type Occurrence, type Verification, type Evidence } from '@hivemagnus/embermend-contracts';
import { DomainError } from './authorization.js';

export function verifiedOccurrence(finding: Finding, occurrence: Occurrence, verification: Verification, evidence: readonly Evidence[], now = new Date()): Occurrence {
  if (verification.occurrenceId !== occurrence.id || finding.id !== occurrence.findingId) throw new DomainError('VERIFICATION_SCOPE_MISMATCH');
  const fresh = now.getTime() - Date.parse(verification.observedAt) >= -120000 && now.getTime() - Date.parse(verification.observedAt) <= 900000;
  if (verification.result !== 'pass') return occurrence;
  if (!fresh || verification.coverage.status !== 'complete' || !verification.independent || !verification.healthPassed || finding.validity !== 'validated') throw new DomainError('INSUFFICIENT_VERIFICATION');
  if (!verification.coverage.examined.includes(occurrence.subjectId) && !verification.coverage.examined.includes(finding.component)) throw new DomainError('AFFECTED_COMPONENT_NOT_REASSESSED');
  if (!verification.evidenceIds.every(id => evidence.some(item => item.id === id && item.subjectId === verification.targetId && item.method === verification.method && Math.abs(Date.parse(item.observedAt) - Date.parse(verification.observedAt)) <= 120000))) throw new DomainError('VERIFICATION_EVIDENCE_MISMATCH');
  const independentEvidence = evidence.filter(item => verification.evidenceIds.includes(item.id) && item.source !== 'ai-scanner');
  if (!independentEvidence.length) throw new DomainError('INDEPENDENT_EVIDENCE_REQUIRED');
  if (finding.kind === 'credential-exposure') {
    if (verification.dimension !== 'credential-invalidation' || !verification.consumerMigrationVerified || !independentEvidence.some(item => item.content['credentialInvalidated'] === true && item.content['consumerMigrationVerified'] === true && item.content['findingIdentity'] === finding.identity)) throw new DomainError('CREDENTIAL_INVALIDATION_OUTSTANDING');
    return { ...occurrence, sourceState: 'verified-fixed', runtimeState: occurrence.runtimeState === 'not-applicable' ? 'not-applicable' : 'verified-resolved', evidenceIds: [...new Set([...occurrence.evidenceIds, ...verification.evidenceIds])] };
  }
  if (verification.dimension === 'source') {
    if (!occurrence.branch || verification.branch !== occurrence.branch || verification.targetId !== occurrence.subjectId || occurrence.sourceState === 'not-applicable') throw new DomainError('SOURCE_BRANCH_OR_COMPONENT_PROOF_REQUIRED');
    if (!verification.revision || !independentEvidence.some(item => item.content['sourceRevision'] === verification.revision && item.content['sourceBranch'] === occurrence.branch && item.content['sourceRepositoryId'] === occurrence.subjectId && item.content['sourceApplicationId'] === finding.component && item.content['findingIdentity'] === finding.identity && item.content['securityCheckPassed'] === true)) throw new DomainError('IMMUTABLE_SOURCE_PROOF_REQUIRED');
    return { ...occurrence, sourceState: 'verified-fixed', evidenceIds: [...new Set([...occurrence.evidenceIds, ...verification.evidenceIds])] };
  }
  if (verification.dimension === 'runtime') {
    if (verification.targetId !== occurrence.subjectId) throw new DomainError('RUNTIME_TARGET_MISMATCH');
    if (finding.kind === 'hardening' || finding.kind === 'os-package') {
      if (!independentEvidence.some(item => item.content['findingIdentity'] === finding.identity && item.content['securityCheckPassed'] === true && item.content['runningStateVerified'] === true)) throw new DomainError('EFFECTIVE_HOST_STATE_PROOF_REQUIRED');
    } else if (!verification.artifactDigest || !independentEvidence.some(item => item.content['deployedArtifactDigest'] === verification.artifactDigest && item.content['securityCheckPassed'] === true && item.content['findingIdentity'] === finding.identity)) throw new DomainError('DEPLOYED_ARTIFACT_PROOF_REQUIRED');
    return { ...occurrence, runtimeState: 'verified-resolved', evidenceIds: [...new Set([...occurrence.evidenceIds, ...verification.evidenceIds])] };
  }
  return { ...occurrence, runtimeState: 'verified-mitigated', evidenceIds: [...new Set([...occurrence.evidenceIds, ...verification.evidenceIds])] };
}
