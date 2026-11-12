import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { permissions, scopeSchema, planSchema, type Actor, type Receipt } from '@hivemagnus/embermend-contracts';
import { claim, json, audit, lock } from '@hivemagnus/embermend-store';
import { DomainError, type Embermend } from '@hivemagnus/embermend-core';
import { observeCampaign } from './campaign-observation.js';
import { runAssessment } from './assessment.js';

const actorSchema = z.object({ id: z.string(), kind: z.enum(['operator', 'coordinator', 'integration']), permissions: z.array(z.enum(permissions)), scope: scopeSchema });
export async function tick(service: Embermend, owner: string, signal: AbortSignal): Promise<boolean> {
  const id = await claim(service.db, owner); if (!id) return false;
  const job = await service.db.job.findUnique({ where: { id } }); if (!job) return false;
  const parsed = actorSchema.parse(job.actor); const actor: Actor = { ...parsed, permissions: new Set(parsed.permissions) };
  const controller = new AbortController(); const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(Math.max(1, job.deadline.getTime() - Date.now()))]);
  const heartbeat = setInterval(() => {
    void service.db.job.updateMany({ where: { id, status: 'running', leaseOwner: owner, leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + 60000) } }).then(async result => { const state = await service.db.job.findUnique({ where: { id } }); if (!result.count || state?.cancelRequested) controller.abort(); }).catch(() => controller.abort());
  }, 10000);
  let result: unknown = { completed: true };
  try {
    if (job.kind === 'reconciliation') {
      const payload = z.object({ originalJobId: z.string(), scope: scopeSchema }).strict().parse(job.payload);
      const original = await service.db.job.findUnique({ where: { id: payload.originalJobId } });
      if (!original || !['assessment', 'vulnerabilities', 'scan', 'preparation', 'source', 'campaign', 'build-observation'].includes(original.kind)) throw new DomainError('JOB_RECONCILIATION_NOT_ELIGIBLE');
      await service.job(actor, original.id);
      if (original.status !== 'unknown') { if (!['completed', 'failed'].includes(original.status)) throw new DomainError('JOB_RECONCILIATION_NOT_ELIGIBLE'); result = { originalJobId: original.id, status: original.status }; }
      else {
        try {
          const observed = original.kind === 'campaign' ? await observeCampaign(service, actor, original) : original.kind === 'build-observation' ? await service.builds.observe(actor, original.payload, { jobId: id, owner, observeOnly: true }, combined) : await runAssessment(service, actor, original, combined, { jobId: id, owner, observeOnly: true });
          result = { originalJobId: original.id, observation: observed };
          await service.db.$transaction(async tx => {
            const lease = await tx.job.findUnique({ where: { id } }); if (lease?.status !== 'running' || lease.leaseOwner !== owner || !lease.leaseUntil || lease.leaseUntil <= new Date()) throw new DomainError('WORKER_LEASE_LOST');
            await tx.job.updateMany({ where: { id: original.id, status: 'unknown' }, data: { status: 'completed', progress: 1, error: null, ...(original.kind === 'build-observation' ? { result: json(observed) } : {}) } });
            await audit(tx, actor, 'job.original-observed', original.id, { observationJobId: id, status: 'completed' });
          });
        } catch (error) {
          if (error instanceof DomainError && ['ASSESSMENT_FAILED_CONFIRMED', 'CAMPAIGN_FAILED_CONFIRMED'].includes(error.code)) await service.db.job.updateMany({ where: { id: original.id, status: 'unknown' }, data: { status: 'failed', error: error.code } });
          throw error;
        }
      }
    } else if (job.kind === 'build-observation') {
      result = await service.builds.observe(actor, job.payload, { jobId: id, owner, observeOnly: false }, combined);
    } else if (job.kind === 'campaign') {
      const payload = z.object({ planId: z.string(), revision: z.number(), scope: scopeSchema }).strict().parse(job.payload); const plan = planSchema.parse(await service.plan(actor, payload.planId));
      if (plan.revision !== payload.revision) throw new DomainError('PLAN_CHANGED');
      const done = new Set<string>(); const remaining = [...plan.actions].sort((a, b) => Number(b.targetId === plan.canaryTargetId) - Number(a.targetId === plan.canaryTargetId));
      while (remaining.length) {
        if (combined.aborted) throw new DomainError('CAMPAIGN_INTERRUPTED_RECONCILE_IN_FLIGHT');
        const next = remaining.find(action => action.dependsOn.every(id => done.has(id))); if (!next) throw new DomainError('DEPENDENCY_NOT_READY');
        let receipt: Receipt;
        try {
          receipt = await service.dispatchForJob(actor, plan.id, next.id, { jobId: id, owner });
          await service.db.job.updateMany({ where: { id, status: 'running', leaseOwner: owner, leaseUntil: { gt: new Date() } }, data: { error: null } });
        } catch (error) {
          // No next action was reserved. Yield only this deliberate verification
          // wait so the same worker can process independent assessment jobs.
          // Resume the same job, with its original authority and deadline; the
          // normal admission path rechecks pause, policy and prior receipts.
          if (!(error instanceof DomainError) || error.code !== 'ACTION_VERIFICATION_REQUIRED') throw error;
          await service.db.job.updateMany({ where: { id, status: 'running', leaseOwner: owner, leaseUntil: { gt: new Date() } }, data: { status: 'queued', availableAt: new Date(Date.now() + 2000), leaseOwner: null, leaseUntil: null, error: error.code, result: json({ actionId: next.id, state: 'awaiting-verification' }) } });
          return true;
        }
        while ((['queued', 'running', 'unknown'].includes(receipt.state) || receipt.state === 'completed' && !receipt.ownershipReleased) && !(receipt.state === 'unknown' && receipt.ownershipReleased && receipt.result['ownershipSettled'] === true) && !combined.aborted) {
          await service.db.job.update({ where: { id }, data: { result: json({ operationId: receipt.operationId, actionId: next.id, state: receipt.state }) } });
          await setTimeout(1000, undefined, { signal: combined }); receipt = await service.reconcile(actor, receipt.operationId);
        }
        if (receipt.state === 'unknown' && receipt.ownershipReleased && receipt.result['ownershipSettled'] === true) throw new DomainError('OWNER_SETTLED_ORIGINAL_OUTCOME_UNKNOWN');
        if (receipt.state !== 'completed' || !receipt.ownershipReleased) throw new DomainError('EXECUTION_AWAITING_RECONCILIATION_OR_VERIFICATION');
        done.add(next.id); remaining.splice(remaining.indexOf(next), 1);
        await service.db.job.update({ where: { id }, data: { progress: done.size / plan.actions.length } });
      }
    } else if (['assessment', 'vulnerabilities', 'scan', 'preparation', 'source'].includes(job.kind)) {
      result = await runAssessment(service, actor, job, combined, { jobId: id, owner, observeOnly: false });
    } else {
      throw new DomainError('UNSUPPORTED_JOB_KIND');
    }
    await service.db.job.updateMany({ where: { id, status: 'running', leaseOwner: owner, leaseUntil: { gt: new Date() } }, data: { status: 'completed', progress: 1, result: json(result) } });
  } catch (error) {
    const code = error instanceof DomainError ? error.code : 'WORKER_FAILED_INSPECT_RETAINED_STATE';
    const retained = await service.db.job.findUnique({ where: { id } });
    await service.db.job.updateMany({ where: { id, status: 'running', leaseOwner: owner, leaseUntil: { gt: new Date() } }, data: { status: ['ASSESSMENT_FAILED_CONFIRMED', 'CAMPAIGN_FAILED_CONFIRMED', 'SOURCE_ADMISSION_CHANGED_BEFORE_DISPATCH'].includes(code) ? 'failed' : ['campaign', 'reconciliation'].includes(job.kind) || retained?.result !== null ? 'unknown' : 'failed', error: code } });
  } finally { clearInterval(heartbeat); }
  return true;
}
async function maintenance(service: Embermend): Promise<void> {
  await service.db.$transaction(async tx => {
    await lock(tx, 'maintenance');
    const exceptions = await tx.exception.findMany({ where: { status: 'active', expiresAt: { lte: new Date() } } });
    for (const exception of exceptions) { const data = z.record(z.string(), z.json()).parse(exception.data); await tx.exception.update({ where: { id: exception.id }, data: { status: 'expired', data: json({ ...data, status: 'expired' }) } }); await tx.outbox.create({ data: { id: randomUUID(), kind: 'exception.expired', subjectId: exception.id, payload: json({ installationId: exception.installationId, findingIds: data['findingIds'] ?? [] }) } }); }
    const schedules = await tx.schedule.findMany({ where: { enabled: true, nextAt: { lte: new Date() } }, take: 100 });
    for (const schedule of schedules) {
      const parsed = actorSchema.parse(schedule.actor); const actor: Actor = { ...parsed, permissions: new Set(parsed.permissions) };
      const key = `${schedule.id}:${schedule.nextAt.toISOString()}`;
      const payload = z.record(z.string(), z.json()).parse(schedule.payload);
      const scheduled = { ...payload, ...(schedule.kind === 'scan' ? { operationId: key } : { id: key }), deadline: new Date(Math.max(Date.now(), schedule.nextAt.getTime()) + Math.min(schedule.intervalSeconds, 3600) * 1000).toISOString() };
      // Keep only fields belonging to this request kind; its normal application
      // scope and source policy admission will run again in the outbox consumer.
      await tx.outbox.create({ data: { id: randomUUID(), kind: 'schedule.assess', subjectId: schedule.id, payload: json({ kind: schedule.kind, request: scheduled, actor: { ...actor, permissions: [...actor.permissions] } }) } });
      await tx.schedule.update({ where: { id: schedule.id }, data: { nextAt: new Date(Date.now() + schedule.intervalSeconds * 1000) } }); await audit(tx, actor, 'schedule.enqueued', schedule.id);
    }
  });
}
async function deliverSchedules(service: Embermend): Promise<void> {
  const rows = await service.db.outbox.findMany({ where: { status: 'queued', kind: 'schedule.assess' }, orderBy: { createdAt: 'asc' }, take: 20 });
  for (const row of rows) {
    const value = z.object({ kind: z.enum(['assessment', 'vulnerabilities', 'scan']), request: z.unknown(), actor: actorSchema }).strict().parse(row.payload);
    const configured = await service.db.schedule.findUnique({ where: { id: row.subjectId } });
    if (!configured?.enabled) { await service.db.outbox.update({ where: { id: row.id }, data: { status: 'canceled' } }); continue; }
    const actor: Actor = { ...value.actor, permissions: new Set(value.actor.permissions) };
    try {
      if (value.kind === 'scan') await service.scan(actor, value.request);
      else if (value.kind === 'assessment') await service.assess(actor, value.request);
      else await service.assessVulnerabilities(actor, value.request);
      await service.db.outbox.update({ where: { id: row.id }, data: { status: 'delivered' } });
    } catch (error) {
      // Changed access is a visible blocked delivery. Operator repair creates a
      // fresh schedule occurrence; no scheduled request bypasses normal admission.
      await service.db.outbox.update({ where: { id: row.id }, data: { status: 'blocked' } });
      await audit(service.db, actor, 'schedule.blocked', row.subjectId, { outboxId: row.id, reason: error instanceof DomainError ? error.code : 'SCHEDULE_ADMISSION_FAILED' });
    }
  }
}
export async function runWorker(service: Embermend, signal: AbortSignal): Promise<void> {
  const owner = randomUUID();
  while (!signal.aborted) { await maintenance(service); await deliverSchedules(service); if (!await tick(service, owner, signal)) await setTimeout(1000, undefined, { signal }).catch(() => undefined); }
}
