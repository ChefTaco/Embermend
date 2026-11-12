import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateHiveEvent, type HiveEvent, type HiveEventSeverity, type Page } from '@hivemagnus/hive-common/contracts';
import { decodeCursor, encodeCursor, feedPage } from '@hivemagnus/hive-common/events';
import { entitySchema, findingSchema, planSchema, type Actor, type Finding, type Plan } from '@hivemagnus/embermend-contracts';
import { within, type Database } from '@hivemagnus/embermend-store';
import { DomainError, requirePermission } from './authorization.js';

/**
 * The Hive:Magnus event feed. Every event is derived from an audit row that Embermend already
 * writes in the same transaction as the change it records, so the feed needs no table of its own
 * and an event exists exactly when its change committed.
 */
export const HIVE_EVENT_RETENTION_MS = 14 * 86400000;
export const HIVE_EVENT_OPERATIONS = ['plan.proposed', 'plan.approve', 'plan.reject', 'plan.policy-authorized', 'campaign.paused', 'campaign.resumed', 'campaign.verification-stop', 'execution.receipt', 'execution.reconciled'] as const;
const BATCH = 500;
const MAX_BATCHES = 20;
const NODE_ID = /^[a-z0-9_-]{2,32}$/;
const KEY = /^[A-Za-z0-9._-]{1,40}$/;

export interface AuditRow { id: string; operation: string; subjectId: string; installationId: string; details: unknown; createdAt: Date }
export interface FeedPosition { occurredAt: string; id: string }
const positionSchema = z.object({ t: z.iso.datetime(), i: z.string().min(1).max(200) }).strict();

export function encodeFeedPosition(position: FeedPosition): string { return encodeCursor({ t: position.occurredAt, i: position.id }); }
export function decodeFeedPosition(cursor: string): FeedPosition {
  let value: unknown;
  try { value = decodeCursor(cursor); } catch { throw new DomainError('INVALID_FEED_CURSOR', 400); }
  const parsed = positionSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('INVALID_FEED_CURSOR', 400);
  return { occurredAt: parsed.data.t, id: parsed.data.i };
}
const compare = (a: FeedPosition, b: FeedPosition): number => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** An identifier segment that fits a HiveEvent ID: the record ID when safe, else a stable digest. */
export function eventKey(value: string): string { return KEY.test(value) ? value : `h-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`; }
function plain(value: string, max: number): string {
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
const link = (name: 'plan' | 'campaign', id: string): { product: 'embermend'; path: string } => ({ product: 'embermend', path: `/?${new URLSearchParams([['page', 'embermend'], [name, id]]).toString()}` });

/** Recommendation severity from its findings' own severity (impact) and priority (urgency). */
export function recommendationSeverity(findings: readonly Pick<Finding, 'severity' | 'priority'>[]): HiveEventSeverity {
  if (findings.some(finding => finding.severity === 'critical' || finding.priority >= 85)) return 'critical';
  if (findings.some(finding => finding.severity === 'high' || finding.priority >= 60)) return 'warning';
  return 'info';
}

const revisionDetails = z.object({ revision: z.number().int().positive() }).passthrough();
const receiptDetails = z.object({ state: z.string() }).passthrough();

class Deriver {
  private readonly plans = new Map<string, Promise<Plan | null>>();
  private readonly nodes = new Map<string, Promise<string | null>>();
  private readonly campaigns = new Map<string, Promise<Plan[] | null>>();
  constructor(private readonly db: Database, private readonly actor: Actor) {}

  private planRevision(planId: string, revision: number): Promise<Plan | null> {
    const key = `${planId}\u0000${revision}`;
    let value = this.plans.get(key);
    if (!value) {
      value = this.db.planRevision.findUnique({ where: { planId_revision: { planId, revision } } }).then(row => { const parsed = row ? planSchema.safeParse(row.data) : null; return parsed?.success ? parsed.data : null; });
      this.plans.set(key, value);
    }
    return value;
  }
  /** The same rule as the recommendation reads: the plan revision's scope must be readable. */
  private async readablePlan(planId: string, revision: number): Promise<Plan | null> {
    const plan = await this.planRevision(planId, revision);
    if (!plan || plan.scope.installationId !== this.actor.scope.installationId || !within(this.actor.scope, plan.scope)) return null;
    return plan;
  }
  /** The same rule as the campaign report: every plan in the campaign must be readable. */
  private campaignPlans(campaignId: string): Promise<Plan[] | null> {
    let value = this.campaigns.get(campaignId);
    if (!value) {
      value = (async () => {
        const campaign = await this.db.campaign.findUnique({ where: { id: campaignId } });
        if (!campaign || campaign.installationId !== this.actor.scope.installationId) return null;
        const plans: Plan[] = [];
        for (const row of await this.db.plan.findMany({ where: { campaignId }, orderBy: { id: 'asc' } })) {
          const plan = await this.readablePlan(row.id, row.currentRevision);
          if (!plan) return null;
          plans.push(plan);
        }
        return plans;
      })();
      this.campaigns.set(campaignId, value);
    }
    return value;
  }
  private node(targetId: string): Promise<string | null> {
    let value = this.nodes.get(targetId);
    if (!value) {
      value = (async () => {
        const row = await this.db.entity.findUnique({ where: { id: targetId } });
        const parsed = row ? entitySchema.safeParse(row.data) : null;
        if (!parsed?.success || parsed.data.kind !== 'target') return null;
        if (parsed.data.targetKind === 'host') return NODE_ID.test(parsed.data.magnusTargetId) ? parsed.data.magnusTargetId : null;
        return parsed.data.parentHostId ? this.node(parsed.data.parentHostId) : null;
      })();
      this.nodes.set(targetId, value);
    }
    return value;
  }
  /** A node ID only when the scope names exactly one Magnus node. */
  private async scopeNode(targetIds: readonly string[]): Promise<string | null> {
    const nodes = new Set<string>();
    for (const id of targetIds.slice(0, 100)) { const node = await this.node(id); if (!node) return null; nodes.add(node); }
    return nodes.size === 1 ? [...nodes][0] ?? null : null;
  }
  private async severity(plan: Plan): Promise<HiveEventSeverity> {
    const findings: Finding[] = [];
    for (const id of plan.findingIds.slice(0, 200)) {
      const row = await this.db.finding.findUnique({ where: { id } });
      const parsed = row ? findingSchema.safeParse(row.data) : null;
      if (parsed?.success) findings.push(parsed.data);
    }
    return recommendationSeverity(findings);
  }

  /** The event for an audit row, or null when the row is not notable or not visible to this actor. */
  async derive(row: AuditRow): Promise<Record<string, unknown> | null> {
    if (row.installationId !== this.actor.scope.installationId) return null;
    const occurredAt = row.createdAt.toISOString();
    const base = { product: 'embermend', occurredAt, sourceRef: row.subjectId.slice(0, 256) };
    const audit = eventKey(row.id);
    switch (row.operation) {
      case 'plan.proposed': case 'plan.approve': case 'plan.reject': case 'plan.policy-authorized': {
        const details = revisionDetails.safeParse(row.details); if (!details.success) return null;
        const plan = await this.readablePlan(row.subjectId, details.data.revision); if (!plan) return null;
        const node = await this.scopeNode(plan.scope.targetIds);
        const subject = node ? { subject: { nodeId: node } } : {};
        const objective = plain(plan.objective, 160);
        const prefix = `embermend:plan:${eventKey(plan.id)}:r${plan.revision}`;
        if (row.operation === 'plan.proposed') {
          const severity = await this.severity(plan);
          const targets = new Set(plan.actions.map(action => action.targetId)).size;
          return { ...base, ...subject, id: `${prefix}:created`, type: 'recommendation.created', severity, title: `Remediation recommended: ${objective}`, summary: plain(`Revision ${plan.revision} proposes ${plan.actions.length} action${plan.actions.length === 1 ? '' : 's'} on ${targets} target${targets === 1 ? '' : 's'} for ${plan.findingIds.length} finding${plan.findingIds.length === 1 ? '' : 's'}. Impact: ${plan.impact}`, 600), link: link('plan', plan.id) };
        }
        const outcome = row.operation === 'plan.approve' ? ['approved', 'Recommendation approved', 'was approved by an operator'] as const : row.operation === 'plan.reject' ? ['rejected', 'Recommendation rejected', 'was rejected by an operator'] as const : ['policy-authorized', 'Recommendation authorized by policy', 'was authorized by a standing policy'] as const;
        return { ...base, ...subject, id: `${prefix}:${outcome[0]}:${audit}`, type: `recommendation.${outcome[0]}`, severity: 'info', title: outcome[1], summary: plain(`Revision ${plan.revision} of "${objective}" ${outcome[2]}.`, 600), link: link('plan', plan.id) };
      }
      case 'campaign.paused': case 'campaign.resumed': case 'campaign.verification-stop': {
        const plans = await this.campaignPlans(row.subjectId); if (!plans) return null;
        const node = await this.scopeNode(plans.flatMap(plan => plan.scope.targetIds));
        const subject = node ? { subject: { nodeId: node } } : {};
        const count = `${plans.length} recommendation${plans.length === 1 ? '' : 's'}`;
        const prefix = `embermend:campaign:${eventKey(row.subjectId)}`;
        if (row.operation === 'campaign.paused') return { ...base, ...subject, id: `${prefix}:paused:${audit}`, type: 'campaign.paused', severity: 'warning', title: 'Remediation campaign paused', summary: `Dispatch is paused for ${count} in this campaign until an operator resumes it.`, link: link('campaign', row.subjectId) };
        if (row.operation === 'campaign.resumed') return { ...base, ...subject, id: `${prefix}:resumed:${audit}`, type: 'campaign.resumed', severity: 'info', title: 'Remediation campaign resumed', summary: `Dispatch may continue for ${count} in this campaign.`, link: link('campaign', row.subjectId) };
        return { ...base, ...subject, id: `${prefix}:verification-stopped:${audit}`, type: 'campaign.verification-stopped', severity: 'warning', title: 'Remediation campaign stopped by a failed verification', summary: `A verification met a stop condition, so the campaign with ${count} was paused. Review the verification before resuming.`, link: link('campaign', row.subjectId) };
      }
      case 'execution.receipt': case 'execution.reconciled': {
        const details = receiptDetails.safeParse(row.details); if (!details.success || !['failed', 'unknown'].includes(details.data.state)) return null;
        const execution = await this.db.execution.findUnique({ where: { id: row.subjectId } }); if (!execution) return null;
        const plan = await this.readablePlan(execution.planId, execution.revision); if (!plan) return null;
        const node = await this.node(execution.targetId);
        const subject = node ? { subject: { nodeId: node } } : {};
        const objective = plain(plan.objective, 160);
        const failed = details.data.state === 'failed';
        return { ...base, ...subject, id: `embermend:execution:${eventKey(execution.id)}:${failed ? 'failed' : 'needs-attention'}:${audit}`, type: failed ? 'execution.failed' : 'execution.needs-attention', severity: 'warning', title: failed ? 'Remediation action failed' : 'Remediation outcome unknown', summary: plain(failed ? `Action ${execution.actionId} of "${objective}" failed. Inspect its receipt in Embermend before retrying.` : `The outcome of action ${execution.actionId} of "${objective}" is unknown. Reconcile the original operation before further changes.`, 600), link: link('plan', plan.id) };
      }
      default: return null;
    }
  }
}

export interface HiveEventFeedOptions { after: string | undefined; limit: number; now?: Date; onDrop?: (reason: { operation: string; issues: number }) => void }

/** One feed page: events strictly after the cursor, oldest first by (occurredAt, id), within the retention window. */
export async function hiveEventFeed(db: Database, actor: Actor, options: HiveEventFeedOptions): Promise<Page<HiveEvent>> {
  requirePermission(actor, 'read', actor.scope);
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) throw new DomainError('INVALID_FEED_QUERY', 400);
  const after = options.after === undefined ? undefined : decodeFeedPosition(options.after);
  const now = options.now ?? new Date();
  const windowStart = new Date(now.getTime() - HIVE_EVENT_RETENTION_MS);
  const from = after && Date.parse(after.occurredAt) > windowStart.getTime() ? new Date(after.occurredAt) : windowStart;
  const deriver = new Deriver(db, actor);
  const drop = options.onDrop ?? (reason => console.warn(JSON.stringify({ event: 'hive_event_dropped', ...reason })));
  const events: HiveEvent[] = [];
  let last: { createdAt: Date; id: string } | null = null;
  let exhausted = false;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const position = last;
    const rows: AuditRow[] = await db.audit.findMany({
      where: { installationId: actor.scope.installationId, operation: { in: [...HIVE_EVENT_OPERATIONS] }, ...(position ? { OR: [{ createdAt: { gt: position.createdAt } }, { createdAt: position.createdAt, id: { gt: position.id } }] } : { createdAt: { gte: from } }) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: BATCH,
    });
    for (const row of rows) {
      if (row.createdAt.getTime() < windowStart.getTime()) continue;
      const candidate = await deriver.derive(row);
      if (!candidate) continue;
      const result = validateHiveEvent(candidate, { strict: true });
      if (!result.ok) { drop({ operation: row.operation, issues: result.issues.length }); continue; }
      if (!after || compare(result.value, after) > 0) events.push(result.value);
    }
    const tail = rows.at(-1);
    if (rows.length < BATCH || !tail) { exhausted = true; break; }
    last = { createdAt: tail.createdAt, id: tail.id };
    // Rows are read in audit order; only events before the newest timestamp read are complete.
    if (events.filter(event => Date.parse(event.occurredAt) < tail.createdAt.getTime()).length > options.limit) break;
  }
  events.sort(compare);
  const cursorOf = (event: HiveEvent): string => encodeFeedPosition(event);
  if (exhausted || !last) return feedPage(events.slice(0, options.limit + 1), options.limit, cursorOf);
  const horizon = last.createdAt.getTime();
  const complete = events.filter(event => Date.parse(event.occurredAt) < horizon);
  if (complete.length > options.limit) return feedPage(complete.slice(0, options.limit + 1), options.limit, cursorOf);
  // The scan budget ran out first: serve what is complete and resume just before the horizon.
  return { data: complete, nextCursor: encodeFeedPosition({ occurredAt: new Date(horizon - 1).toISOString(), id: '~' }) };
}
