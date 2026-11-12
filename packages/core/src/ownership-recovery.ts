import { evidenceSchema, type Action, type Plan } from '@hivemagnus/embermend-contracts';
import { digest, within, type Transaction } from '@hivemagnus/embermend-store';
import { z } from 'zod';
import { DomainError, parameterSchemas } from './authorization.js';

const reviewSchema = z.object({
  originalOperationId: z.string(), originalRequestDigest: z.string(), nativeCommandId: z.string(), nativeRequestDigest: z.string(),
  originalOutcome: z.literal('unknown'), disposition: z.enum(['effects_verified', 'no_effect_verified']),
  actionVersion: z.enum(['reboot.v1', 'ubuntu-oval.v1', 'repository-scan.v1']),
  independent: z.literal(true), executionGroupEmpty: z.literal(true),
  rebootScheduleAbsent: z.literal(true), rootlessContainerAbsent: z.literal(true), workspaceUnmounted: z.literal(true),
  observedBootId: z.uuid(),
}).passthrough();

/** A missing result is never evidence of absence. Only a fresh independent
 * technical review and a separate explicit decision may settle a held owner. */
export async function admitOwnershipRecovery(tx: Transaction, plan: Plan, action: Action, executorId: string, approverId: string | null): Promise<void> {
  if (action.version !== 'execution-settle.v1') return;
  if (!approverId || approverId === executorId) throw new DomainError('SEPARATE_EXPLICIT_RECOVERY_APPROVAL_REQUIRED');
  const parameters = parameterSchemas['execution-settle.v1'].parse(action.parameters);
  if (!plan.evidenceIds.includes(parameters.evidenceId)) throw new DomainError('RECOVERY_REVIEW_NOT_BOUND_TO_PLAN');
  const row = await tx.evidence.findUnique({ where: { id: parameters.evidenceId } });
  const evidence = row ? evidenceSchema.parse(row.data) : null;
  if (!evidence || !within(plan.scope, evidence.scope) || evidence.subjectId !== action.targetId || evidence.method !== 'owner-settlement-review.v1' || evidence.source !== 'operator-technical-review' || evidence.digest !== parameters.evidenceDigest || digest(evidence.content) !== parameters.evidenceDigest || Math.abs(Date.now() - Date.parse(evidence.observedAt)) > 300000) throw new DomainError('FRESH_INDEPENDENT_OWNER_REVIEW_REQUIRED');
  const review = reviewSchema.parse(evidence.content);
  for (const key of ['originalOperationId', 'originalRequestDigest', 'nativeCommandId', 'nativeRequestDigest', 'originalOutcome', 'disposition'] as const) {
    if (review[key] !== parameters[key]) throw new DomainError('OWNER_REVIEW_IDENTITY_CHANGED');
  }
  const ingestion = await tx.audit.findFirst({ where: { operation: 'evidence.ingested', subjectId: evidence.id }, orderBy: { createdAt: 'asc' } });
  if (!ingestion || ingestion.actorId === executorId || ingestion.actorId === approverId) throw new DomainError('INDEPENDENT_OWNER_REVIEW_REQUIRED');
}
