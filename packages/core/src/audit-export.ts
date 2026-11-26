import type { Page } from '@hivemagnus/hive-common/contracts';
import { redact, redactText } from '@hivemagnus/hive-common/log';
import { z } from 'zod';
import { entitySchema, hiveAuditRecordSchema, type Actor, type HiveAuditRecord } from '@hivemagnus/embermend-contracts';
import type { Database } from '@hivemagnus/embermend-store';
import { DomainError } from './authorization.js';
import { createHash } from 'node:crypto';
import { decodeFeedPosition, encodeFeedPosition } from './hive-events.js';

/**
 * The suite audit export. Every committed Embermend audit row becomes one HiveAuditRecord,
 * oldest first by (createdAt, id), with no retention window: the collector keeps its own copy.
 */
export interface ExportedAuditRow { id: string; actorId: string; actorKind: string | null; operation: string; subjectId: string; installationId: string; details: unknown; createdAt: Date }
export interface AuditExportOptions {
  after: string | undefined;
  limit: number;
  /** The configured actor kind of an audit actor, for rows written before the kind was recorded. */
  actorKind?: (actorId: string) => Actor['kind'] | undefined;
}

/** Detail keys that carry operator-written text rather than identifiers. */
const FREE_TEXT_KEYS = new Set(['impact', 'objective', 'reason', 'summary', 'content', 'message', 'prompt']);
const MAX_DETAIL_STRING = 256;
/** The native ID part of the shared HiveAuditRecord ID pattern; other IDs use a stable digest. */
const NATIVE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_DETAILS_BYTES = 4096;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,99}$/;
/** Record identifiers whose key only resembles a secret name: kept, with the value scrubbed as text. */
const IDENTIFIER_KEYS = new Set(['authorizationId']);
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Embermend operations are dotted lowercase; hyphens become underscores. */
export function auditAction(operation: string): string { return operation.toLowerCase().replace(/[^a-z0-9.]+/g, '_'); }

function actorType(row: ExportedAuditRow, resolve: AuditExportOptions['actorKind']): HiveAuditRecord['actor']['type'] {
  if (row.actorId.startsWith('worker:')) return 'system';
  const kind = row.actorKind ?? resolve?.(row.actorId);
  return kind === 'operator' ? 'user' : 'service';
}

function targetType(operation: string): string {
  if (operation.startsWith('provider.effect.')) return 'provider-effect';
  if (operation.startsWith('provider.')) return 'execution';
  if (operation === 'source.preparation.requested') return 'preparation';
  return operation.split('.')[0] ?? 'unknown';
}

function outcome(row: ExportedAuditRow): HiveAuditRecord['outcome'] {
  const details = typeof row.details === 'object' && row.details !== null && !Array.isArray(row.details) ? row.details : {};
  const state = 'state' in details ? details.state : undefined;
  const result = 'result' in details ? details.result : undefined;
  // An unknown effect needs reconciliation: reported as a failure so collectors raise it.
  if ((row.operation === 'execution.receipt' || row.operation === 'execution.reconciled') && (state === 'failed' || state === 'unknown')) return 'failure';
  if (row.operation === 'verification.recorded' && result === 'fail') return 'failure';
  return 'success';
}

/** Flat scalar details: identifiers, digests, revisions and states only, redacted and within 4 KB. */
export function auditDetails(row: Pick<ExportedAuditRow, 'details' | 'installationId'>): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = { installationId: redactText(row.installationId.slice(0, MAX_DETAIL_STRING)) };
  const source = typeof row.details === 'object' && row.details !== null && !Array.isArray(row.details) ? Object.entries(row.details).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : [];
  for (const [key, value] of source) {
    if (key.length > 64 || key === 'installationId' || FREE_TEXT_KEYS.has(key) && !(typeof value === 'string' && SAFE_REASON.test(value))) continue;
    let scalar: string | number | boolean | null;
    if (typeof value === 'string') scalar = value.length > MAX_DETAIL_STRING ? `${value.slice(0, MAX_DETAIL_STRING - 1)}…` : value;
    else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) scalar = value;
    else continue;
    // Redact before measuring: masking can lengthen a short value.
    const safe = IDENTIFIER_KEYS.has(key) && typeof scalar === 'string' ? redactText(scalar) : redact({ [key]: scalar })[key] ?? null;
    const candidate = { ...output, [key]: safe };
    if (bytes(candidate) > MAX_DETAILS_BYTES) break;
    output[key] = safe;
  }
  return output;
}

export function auditRecord(row: ExportedAuditRow, resolve?: AuditExportOptions['actorKind'], nodeId?: string): HiveAuditRecord {
  const record = {
    id: `embermend:audit:${NATIVE_ID.test(row.id) ? row.id : `h-${createHash('sha256').update(row.id).digest('hex')}`}`,
    product: 'embermend' as const,
    occurredAt: row.createdAt.toISOString(),
    action: auditAction(row.operation),
    outcome: outcome(row),
    actor: { type: actorType(row, resolve), id: row.actorId.slice(0, 256) },
    // Empty objects are omitted, never sent as {}.
    target: { type: targetType(row.operation), ...(row.subjectId ? { id: row.subjectId.slice(0, 256) } : {}) },
    // The Magnus node a finding was observed on or an execution ran on, for host correlation.
    ...(nodeId ? { subject: { nodeId } } : {}),
    details: auditDetails(row),
  };
  return hiveAuditRecordSchema.parse(record);
}

const NODE_ID = /^[a-z0-9_-]{2,32}$/;
const FINDING_OPERATIONS = new Set(['finding.observed', 'finding.recurred']);
const EXECUTION_OPERATIONS = new Set(['execution.receipt', 'execution.reconciled']);
/**
 * The Magnus node ID behind each finding and execution row of a page: the host target's Magnus
 * ID, or a workload's parent host. Read in three batched queries per page.
 */
async function rowNodes(db: Database, rows: readonly ExportedAuditRow[]): Promise<Map<string, string>> {
  const subjectOf = new Map<string, string>();
  for (const row of rows) {
    if (!FINDING_OPERATIONS.has(row.operation)) continue;
    const parsed = z.object({ occurrenceSubject: z.string() }).passthrough().safeParse(row.details);
    if (parsed.success) subjectOf.set(row.id, parsed.data.occurrenceSubject);
  }
  const executionIds = rows.filter(row => EXECUTION_OPERATIONS.has(row.operation)).map(row => row.subjectId);
  if (executionIds.length) {
    const targets = new Map((await db.execution.findMany({ where: { id: { in: [...new Set(executionIds)] } }, select: { id: true, targetId: true } })).map(execution => [execution.id, execution.targetId]));
    for (const row of rows) { const target = EXECUTION_OPERATIONS.has(row.operation) ? targets.get(row.subjectId) : undefined; if (target) subjectOf.set(row.id, target); }
  }
  if (!subjectOf.size) return new Map();
  const entities = async (ids: readonly string[]) => new Map((await db.entity.findMany({ where: { id: { in: [...new Set(ids)] }, kind: 'target' } })).flatMap(row => { const parsed = entitySchema.safeParse(row.data); return parsed.success && parsed.data.kind === 'target' ? [[row.id, parsed.data] as const] : []; }));
  const direct = await entities([...subjectOf.values()]);
  const parents = await entities([...direct.values()].flatMap(target => target.targetKind !== 'host' && target.parentHostId ? [target.parentHostId] : []));
  const nodeOf = (id: string): string | undefined => {
    const target = direct.get(id) ?? parents.get(id); if (!target) return undefined;
    if (target.targetKind === 'host') return NODE_ID.test(target.magnusTargetId) ? target.magnusTargetId : undefined;
    const parent = target.parentHostId ? parents.get(target.parentHostId) : undefined;
    return parent?.targetKind === 'host' && NODE_ID.test(parent.magnusTargetId) ? parent.magnusTargetId : undefined;
  };
  const result = new Map<string, string>();
  for (const [rowId, subject] of subjectOf) { const node = nodeOf(subject); if (node) result.set(rowId, node); }
  return result;
}

/**
 * Who may export: a service actor (coordinator or integration) holding `audit:read` exports every
 * installation; an operator holding `audit:read` exports its own installation only.
 */
export function auditExportInstallation(actor: Actor): string | null {
  if (!actor.permissions.has('audit:read')) throw new DomainError('SCOPE_OR_PERMISSION_DENIED', 403);
  return actor.kind === 'operator' ? actor.scope.installationId : null;
}

/** One export page: records strictly after the cursor, oldest first by (createdAt, id). */
export async function auditExport(db: Database, actor: Actor, options: AuditExportOptions): Promise<Page<HiveAuditRecord>> {
  const installationId = auditExportInstallation(actor);
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) throw new DomainError('INVALID_FEED_QUERY', 400);
  const after = options.after === undefined ? undefined : decodeFeedPosition(options.after);
  const position = after ? new Date(after.occurredAt) : undefined;
  const rows: ExportedAuditRow[] = await db.audit.findMany({
    where: { ...(installationId === null ? {} : { installationId }), ...(after && position ? { OR: [{ createdAt: { gt: position } }, { createdAt: position, id: { gt: after.id } }] } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: options.limit,
  });
  const data = rows.slice(0, options.limit);
  // The last record's cursor is returned even on the final page, so a collector resumes from it;
  // null means nothing is newer than the cursor.
  const last = data.at(-1);
  const nodes = await rowNodes(db, data);
  return { data: data.map(row => auditRecord(row, options.actorKind, nodes.get(row.id))), nextCursor: last ? encodeFeedPosition({ occurredAt: last.createdAt.toISOString(), id: last.id }) : null };
}
