import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { assessmentRequestSchema, vulnerabilityAssessmentSchema, scanRequestSchema, sourceRequestSchema, sourceResultSchema, preparationSchema, preparationResultSchema, profileSchema, entitySchema, scanResultSchema, type Actor, type OperationRequest, type Action, type Receipt } from '@hivemagnus/embermend-contracts';
import { digest, json } from '@hivemagnus/embermend-store';
import { ingestVulnerabilities } from './vulnerabilities.js';
import { DomainError, requirePermission, assertTarget, type Embermend } from '@hivemagnus/embermend-core';
import { reconcileDeploymentInventory } from './deployment-inventory.js';
import { AssessmentLedger } from './assessment-ledger.js';

export async function runAssessment(service: Embermend, actor: Actor, job: { id: string; kind: string; payload: unknown; deadline: Date }, signal: AbortSignal, lease: { jobId: string; owner: string; observeOnly: boolean }): Promise<unknown> {
  requirePermission(actor, lease.observeOnly ? 'recover' : job.kind === 'preparation' ? 'prepare' : 'assess', actor.scope);
  const scan = job.kind === 'scan' ? scanRequestSchema.parse(job.payload) : null;
  const preparation = job.kind === 'preparation' ? preparationSchema.parse(job.payload) : null;
  const source = job.kind === 'source' ? sourceRequestSchema.parse(job.payload) : null;
  const vulnerabilities = job.kind === 'vulnerabilities' ? vulnerabilityAssessmentSchema.parse(job.payload) : null;
  const request = scan || preparation || source || vulnerabilities ? null : assessmentRequestSchema.parse(job.payload);
  const targetIds = scan ? [scan.workerTargetId] : preparation ? [preparation.workerTargetId] : source ? [source.workerTargetId] : vulnerabilities ? [vulnerabilities.targetId] : request?.targetIds ?? [];
  const ledger = await AssessmentLedger.open(service.db, job.id, lease.jobId, lease.owner);
  const capabilities = lease.observeOnly ? null : await service.magnus.capabilities(signal);
  const system: Actor = { id: `worker:${job.id}`, kind: 'integration', permissions: new Set(['read', 'evidence', 'ingest']), scope: actor.scope };
  for (const targetId of targetIds) {
    const operationId = scan?.operationId ?? digest(['assessment-operation', job.id, job.kind, targetId]);
    let entry = ledger.get(operationId);
    if (entry?.result !== undefined) continue;
    let receipt: Receipt;
    if (entry) {
      // Observing an admitted identity is always read-only, even on a resumed
      // initial handler. Never reconstruct a request with current capabilities.
      receipt = await service.magnus.receipt(operationId, signal);
    } else {
      if (lease.observeOnly) throw new DomainError('ORIGINAL_OPERATION_NOT_RETAINED');
      if (signal.aborted) throw new DomainError('ASSESSMENT_INTERRUPTED_BEFORE_ADMISSION');
      const target = capabilities?.targets.find(item => item.id === targetId); if (!target || target.kind !== 'target') throw new DomainError('ASSESSMENT_TARGET_UNAVAILABLE');
      const agent = capabilities?.agents?.find(item => item.id === target.agentId); if (agent) await service.entity(system, agent);
      await service.entity(system, entitySchema.parse(target));
      const version = vulnerabilities ? vulnerabilities.kind === 'ubuntu' ? 'ubuntu-oval.v1' : 'image-vulnerabilities.v1' : scan ? 'repository-scan.v1' : preparation ? 'repository-prepare.v1' : source ? 'repository-source.v1' : 'inventory.v1';
      const action: Action = { id: `assessment:${operationId}`, version, class: preparation ? 'prepare' : 'assess', targetId, targetKind: scan || preparation || source ? 'worker' : target.targetKind, requiredCapabilities: [`embermend:${version}`], parameters: vulnerabilities ? vulnerabilities.kind === 'ubuntu' ? {} : { imageRef: vulnerabilities.imageRef } : scan ? { request: scan } : preparation ? { request: preparation } : source ? { request: source } : { sections: ['packages', 'services', 'listeners', 'configuration', 'docker', 'compose'], profileId: request?.profileId ?? 'unknown' }, preconditions: {}, dependsOn: [], verificationIds: [operationId], recovery: 'Assessment or preparation has no intended managed-system or persistent-source mutation', expectedRevision: scan?.commit ?? preparation?.baseCommit ?? source?.commit ?? null, patchDigest: null, disruption: 'none' };
      assertTarget(action, target);
      if (!capabilities) throw new DomainError('ASSESSMENT_CAPABILITIES_REQUIRED');
      const operation: OperationRequest = { operationId, planId: job.id, planRevision: 1, planDigest: digest(job.payload), action, installationId: capabilities.installationId, authorizationRef: `assessment-grant:${actor.id}:${job.id}`, expiresAt: job.deadline.toISOString() };
      entry = await ledger.reserve(operation, target);
      receipt = await service.magnus.dispatch(operation, signal);
    }
    await ledger.receipt(entry, targetId, receipt);
    while ((['queued', 'running', 'unknown'].includes(receipt.state) || receipt.state === 'completed' && !receipt.ownershipReleased) && !signal.aborted) { await setTimeout(1000, undefined, { signal }); receipt = await service.magnus.receipt(operationId, signal); await ledger.receipt(entry, targetId, receipt); }
    if (receipt.state === 'failed' && receipt.ownershipReleased) throw new DomainError('ASSESSMENT_FAILED_CONFIRMED');
    if (receipt.state !== 'completed' || !receipt.ownershipReleased) throw new DomainError('ASSESSMENT_OUTCOME_UNKNOWN_OR_FAILED');
    let assessed: unknown;
    if (vulnerabilities) {
      assessed = await ingestVulnerabilities(service, system, vulnerabilities, receipt.result, operationId);
    } else if (scan) {
      const result = scanResultSchema.parse(receipt.result['scanResult']);
      if (result.commit !== scan.commit || result.operationId !== operationId) throw new DomainError('SCANNER_RESULT_REVISION_MISMATCH');
      for (const candidate of result.candidates) {
        const evidenceId = digest(['scanner-evidence', operationId, candidate.fingerprint]); const findingId = digest([scan.providerId, candidate.fingerprint]);
        await service.evidence(system, { id: evidenceId, scope: scan.scope, subjectId: scan.repositoryId, method: result.profile, observedAt: result.coverage.observedAt, digest: digest(candidate), content: { ...candidate, scannerVersion: result.scannerVersion, commit: result.commit, modelRef: result.modelRef }, sensitivity: 'ordinary', source: 'ai-scanner' });
        await service.finding(system, { id: findingId, scope: scan.scope, kind: candidate.weakness === 'secret' ? 'credential-exposure' : 'code', identity: candidate.fingerprint, component: candidate.component, weakness: candidate.weakness, title: candidate.title, severity: candidate.severity, confidence: candidate.confidence, validity: 'candidate', rationale: candidate.evidence, evidenceIds: [evidenceId], classifications: [], priority: candidate.severity === 'critical' ? 90 : candidate.severity === 'high' ? 75 : 40 }, { id: digest([findingId, scan.commit, scan.branch, candidate.path]), findingId, subjectId: scan.repositoryId, branch: scan.branch, revision: scan.commit, artifactDigest: null, sourceState: 'open', runtimeState: 'unknown', coverage: result.coverage, evidenceIds: [evidenceId], recurrenceOf: null });
      }
      assessed = result;
    } else if (source) {
      const result = sourceResultSchema.parse(receipt.result['sourceResult']); if (result.commit !== source.commit || result.repositoryId !== source.repositoryId) throw new DomainError('SOURCE_RESULT_IDENTITY_MISMATCH'); assessed = result;
    } else if (preparation) {
      const result = preparationResultSchema.parse(receipt.result['preparationResult']);
      if (result.preparationId !== preparation.id || result.baseCommit !== preparation.baseCommit || result.patchDigest !== digest(preparation.edits) || digest(result.edits) !== result.patchDigest) throw new DomainError('PREPARED_PATCH_IDENTITY_MISMATCH');
      await service.db.preparation.update({ where: { id: preparation.id }, data: { result: json(result) } });
      assessed = result;
    } else if (request) {
      const target = entry.target; if (!target || target.kind !== 'target') throw new DomainError('ASSESSMENT_ORIGINAL_TARGET_MISSING');
      const row = await service.db.profile.findUnique({ where: { id_version: { id: request.profileId, version: request.profileVersion } } });
      if (!row) throw new DomainError('PROFILE_VERSION_UNAVAILABLE'); const profile = profileSchema.parse(row.data);
      const evidenceId = digest(['inventory-evidence', operationId]); const observedAt = receipt.observedAt;
      await service.evidence(system, { id: evidenceId, scope: { ...request.scope, targetIds: [targetId] }, subjectId: targetId, method: `${profile.id}:${profile.version}`, observedAt, digest: digest(receipt.result), content: receipt.result, sensitivity: 'ordinary', source: 'magnus' });
      const checks = [];
      for (const rule of profile.rules) {
        if (profile.platform !== target.platform) { checks.push({ ruleId: rule.id, state: 'not-applicable' }); continue; }
        const field = (path: string): unknown => { let value: unknown = receipt.result; for (const segment of path.split('.')) { const object = z.record(z.string(), z.unknown()).safeParse(value); value = object.success && Object.hasOwn(object.data, segment) ? object.data[segment] : undefined; } return value; };
        if (!target.capabilities.includes(`embermend:${rule.capability}`)) { checks.push({ ruleId: rule.id, state: 'not-assessed' }); continue; }
        if (rule.appliesWhen) { const value = field(rule.appliesWhen.field); if (value === undefined) { checks.push({ ruleId: rule.id, state: 'not-assessed' }); continue; } if (digest(value) !== digest(rule.appliesWhen.equals)) { checks.push({ ruleId: rule.id, state: 'not-applicable' }); continue; } }
        const value = field(rule.field);
        const state = value === undefined ? 'not-assessed' : digest(value) === digest(rule.expected) ? 'pass' : 'fail'; checks.push({ ruleId: rule.id, state });
        if (state === 'fail') {
          const findingId = digest([targetId, profile.id, rule.id]);
          await service.finding(system, { id: findingId, scope: { ...request.scope, targetIds: [targetId] }, kind: 'hardening', identity: findingId, component: targetId, weakness: rule.id, title: rule.explanation, severity: 'medium', confidence: 1, validity: 'validated', rationale: 'Effective configuration differs from the assigned versioned rule', evidenceIds: [evidenceId], classifications: [profile.id, rule.id], priority: 50 }, { id: digest([findingId, targetId]), findingId, subjectId: targetId, branch: null, revision: null, artifactDigest: null, sourceState: 'not-applicable', runtimeState: 'affected', coverage: { status: 'complete', requested: [targetId], examined: [targetId], excluded: [], failures: [], mode: 'full', observedAt }, evidenceIds: [evidenceId], recurrenceOf: null });
        }
      }
      const deployments = await reconcileDeploymentInventory(service, system, await service.readEvidence(system, evidenceId));
      assessed = { checks, evidenceId, deployments, coverage: checks.some(check => check.state === 'not-assessed') ? 'partial' : 'complete' };
    }
    await ledger.result(entry, assessed);
  }
  return ledger.value();
}
