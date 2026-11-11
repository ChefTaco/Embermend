import { z } from 'zod';
import { planSchema, scopeSchema, type Actor } from '@hivemagnus/embermend-contracts';
import { DomainError, requirePermission, type Embermend } from '@hivemagnus/embermend-core';
/** Adopt only already-reserved operations. A missing action never starts here. */
export async function observeCampaign(service: Embermend, actor: Actor, original: { payload: unknown }): Promise<unknown> {
  const payload = z.object({ planId: z.string(), revision: z.number().int().positive(), scope: scopeSchema }).strict().parse(original.payload);
  requirePermission(actor, 'recover', payload.scope); requirePermission(actor, 'evidence', payload.scope);
  const revision = await service.db.planRevision.findUnique({ where: { planId_revision: { planId: payload.planId, revision: payload.revision } } });
  if (!revision) throw new DomainError('ORIGINAL_PLAN_REVISION_MISSING');
  const plan = planSchema.parse(revision.data); requirePermission(actor, 'read', plan.scope);
  const operations = [];
  for (const action of plan.actions) {
    const execution = await service.db.execution.findUnique({ where: { planId_revision_actionId: { planId: plan.id, revision: plan.revision, actionId: action.id } } });
    if (!execution) throw new DomainError('CAMPAIGN_ACTION_NOT_DISPATCHED_OBSERVATION_ONLY');
    const receipt = await service.reconcile(actor, execution.id);
    if (receipt.state === 'failed' && receipt.ownershipReleased) throw new DomainError('CAMPAIGN_FAILED_CONFIRMED');
    if (receipt.state !== 'completed' || !receipt.ownershipReleased) throw new DomainError('CAMPAIGN_ORIGINAL_OUTCOME_UNKNOWN');
    operations.push({ actionId: action.id, operationId: execution.id, state: receipt.state, ownershipReleased: true });
  }
  return { planId: plan.id, revision: plan.revision, operations };
}
