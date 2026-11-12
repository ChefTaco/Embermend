import type { Page } from '@hivemagnus/hive-common/contracts';
import { feedPage } from '@hivemagnus/hive-common/events';
import { redact } from '@hivemagnus/hive-common/log';
import { hiveAuditRecordSchema, type Actor, type HiveAuditRecord } from '@hivemagnus/embermend-contracts';
import type { Database } from '@hivemagnus/embermend-store';
import { DomainError } from './authorization.js';
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
const MAX_DETAILS_BYTES = 4096;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,99}$/;
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
  if ((row.operation === 'execution.receipt' || row.operation === 'execution.reconciled') && state === 'failed') return 'failure';
  if (row.operation === 'verification.recorded' && result === 'fail') return 'failure';
  return 'success';
}

/** Flat scalar details: identifiers, digests, revisions and states only, redacted and within 4 KB. */
export function auditDetails(row: Pick<ExportedAuditRow, 'details' | 'installationId'>): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = { installationId: row.installationId.slice(0, MAX_DETAIL_STRING) };
  const source = typeof row.details === 'object' && row.details !== null && !Array.isArray(row.details) ? Object.entries(row.details).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : [];
  for (const [key, value] of source) {
    if (key.length > 64 || key === 'installationId' || FREE_TEXT_KEYS.has(key) && !(typeof value === 'string' && SAFE_REASON.test(value))) continue;
    let scalar: string | number | boolean | null;
    if (typeof value === 'string') scalar = value.length > MAX_DETAIL_STRING ? `${value.slice(0, MAX_DETAIL_STRING - 1)}…` : value;
    else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) scalar = value;
    else continue;
    const candidate = { ...output, [key]: scalar };
    if (bytes(candidate) > MAX_DETAILS_BYTES) break;
    output[key] = scalar;
  }
  return redact(output);
}

export function auditRecord(row: ExportedAuditRow, resolve?: AuditExportOptions['actorKind']): HiveAuditRecord {
  const record = {
    id: `embermend:audit:${row.id}`,
    product: 'embermend' as const,
    occurredAt: row.createdAt.toISOString(),
    action: auditAction(row.operation),
    outcome: outcome(row),
    actor: { type: actorType(row, resolve), id: row.actorId.slice(0, 256) },
    target: { type: targetType(row.operation), id: row.subjectId.slice(0, 256) },
    details: auditDetails(row),
  };
  return hiveAuditRecordSchema.parse(record);
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
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: options.limit + 1,
  });
  const page = feedPage(rows, options.limit, row => encodeFeedPosition({ occurredAt: row.createdAt.toISOString(), id: row.id }));
  return { data: page.data.map(row => auditRecord(row, options.actorKind)), nextCursor: page.nextCursor };
}
