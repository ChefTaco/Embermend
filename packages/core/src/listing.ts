import { z } from 'zod';
import type { Page } from '@hivemagnus/hive-common/contracts';
import { decodeCursor, encodeCursor } from '@hivemagnus/hive-common/events';
import type { Scope } from '@hivemagnus/embermend-contracts';
import { Prisma, type Database } from '@hivemagnus/embermend-store';
import { DomainError } from './authorization.js';

/** One list page request: an opaque cursor from a previous page and a page size. */
export interface ListQuery { after: string | undefined; limit: number }
export type { Page };
/** Page size bounds for `?limit=` on the list endpoints. */
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

/** How many rows each list returns when it is called without `limit` or `after`, as before pagination. */
export const LEGACY_LIST_LIMITS = { entities: 1000, findings: 1000, recommendations: 200, relationships: 2000, assignments: 1000, exceptions: 1000, builds: 1000 } as const;

/** Tables whose rows carry their scope at `data.scope` next to an `installationId` column. */
export type ScopedTable = 'Entity' | 'Finding' | 'Exception' | 'ProfileAssignment' | 'Build';
/** `id`: ascending ID. `recent`: newest `updatedAt` first, then descending ID. */
export type ListOrder = 'id' | 'recent';

const idCursor = z.object({ i: z.string().min(1).max(512) }).strict();
const recentCursor = z.object({ t: z.iso.datetime(), i: z.string().min(1).max(512) }).strict();
export interface ListPosition { id: string; updatedAt?: string }

export function encodeListCursor(order: ListOrder, position: ListPosition): string {
  if (order === 'id') return encodeCursor({ i: position.id });
  if (position.updatedAt === undefined) throw new Error('A recent-order cursor needs updatedAt');
  return encodeCursor({ t: position.updatedAt, i: position.id });
}
export function decodeListCursor(order: ListOrder, cursor: string): ListPosition {
  let value: unknown;
  try { value = decodeCursor(cursor); } catch { throw new DomainError('INVALID_LIST_CURSOR', 400); }
  if (order === 'id') { const parsed = idCursor.safeParse(value); if (!parsed.success) throw new DomainError('INVALID_LIST_CURSOR', 400); return { id: parsed.data.i }; }
  const parsed = recentCursor.safeParse(value); if (!parsed.success) throw new DomainError('INVALID_LIST_CURSOR', 400);
  return { id: parsed.data.i, updatedAt: parsed.data.t };
}

const positionRows = z.array(z.object({ id: z.string(), t: z.string().nullable().optional() }));
const TABLES: Readonly<Record<ScopedTable, Prisma.Sql>> = { Entity: Prisma.raw('"Entity"'), Finding: Prisma.raw('"Finding"'), Exception: Prisma.raw('"Exception"'), ProfileAssignment: Prisma.raw('"ProfileAssignment"'), Build: Prisma.raw('"Build"') };
/** UTC milliseconds, as Prisma stores `DateTime` in `timestamp(3)` columns. */
const iso = (column: Prisma.Sql): Prisma.Sql => Prisma.sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * The SQL form of `within(scope, <row scope>)`: same installation, and every application and
 * target of the row's scope is one of the caller's. JSONB array containment (`<@`) holds exactly
 * when every element of the left array is in the right one.
 */
export function scopeCondition(scopeColumn: Prisma.Sql, scope: Scope): Prisma.Sql {
  return Prisma.sql`(${scopeColumn}->>'installationId') = ${scope.installationId}
    AND jsonb_typeof(${scopeColumn}->'applicationIds') = 'array' AND jsonb_typeof(${scopeColumn}->'targetIds') = 'array'
    AND (${scopeColumn}->'applicationIds') <@ ${JSON.stringify(scope.applicationIds)}::jsonb
    AND (${scopeColumn}->'targetIds') <@ ${JSON.stringify(scope.targetIds)}::jsonb`;
}

function cursorCondition(order: ListOrder, after: ListPosition | undefined, idColumn: Prisma.Sql, updatedColumn: Prisma.Sql): Prisma.Sql {
  if (!after) return Prisma.empty;
  if (order === 'id') return Prisma.sql`AND ${idColumn} > ${after.id}`;
  return Prisma.sql`AND (${updatedColumn}, ${idColumn}) < (CAST(${after.updatedAt ?? ''} AS timestamp(3)), ${after.id})`;
}
const orderBy = (order: ListOrder, idColumn: Prisma.Sql, updatedColumn: Prisma.Sql): Prisma.Sql => order === 'id' ? Prisma.sql`ORDER BY ${idColumn} ASC` : Prisma.sql`ORDER BY ${updatedColumn} DESC, ${idColumn} DESC`;

/**
 * The IDs of one page of rows the scope can read, filtered and ordered in the database, so a
 * narrowly scoped caller gets a complete page instead of a post-filtered sample. One extra row
 * is fetched to tell whether another page follows.
 */
export async function scopedPositions(db: Database, table: ScopedTable, order: ListOrder, scope: Scope, query: ListQuery): Promise<ListPosition[]> {
  if (!Number.isInteger(query.limit) || query.limit < 1) throw new DomainError('INVALID_LIST_QUERY', 400);
  const after = query.after === undefined ? undefined : decodeListCursor(order, query.after);
  const id = Prisma.raw('id'); const updated = Prisma.raw('"updatedAt"');
  const rows: unknown = await db.$queryRaw`SELECT id${order === 'recent' ? Prisma.sql`, ${iso(updated)} AS t` : Prisma.empty} FROM ${TABLES[table]}
    WHERE "installationId" = ${scope.installationId} AND ${scopeCondition(Prisma.raw(`data->'scope'`), scope)} ${cursorCondition(order, after, id, updated)}
    ${orderBy(order, id, updated)} LIMIT ${query.limit + 1}`;
  return positionRows.parse(rows).map(row => ({ id: row.id, ...(row.t ? { updatedAt: row.t } : {}) }));
}

/** Plans whose current revision the scope can read, most recently changed first. */
export async function scopedPlanPositions(db: Database, scope: Scope, query: ListQuery): Promise<ListPosition[]> {
  if (!Number.isInteger(query.limit) || query.limit < 1) throw new DomainError('INVALID_LIST_QUERY', 400);
  const after = query.after === undefined ? undefined : decodeListCursor('recent', query.after);
  const id = Prisma.raw('p.id'); const updated = Prisma.raw('p."updatedAt"');
  const rows: unknown = await db.$queryRaw`SELECT p.id, ${iso(updated)} AS t FROM "Plan" p
    JOIN "PlanRevision" r ON r."planId" = p.id AND r.revision = p."currentRevision"
    WHERE p."installationId" = ${scope.installationId} AND ${scopeCondition(Prisma.raw(`r.data->'scope'`), scope)} ${cursorCondition('recent', after, id, updated)}
    ${orderBy('recent', id, updated)} LIMIT ${query.limit + 1}`;
  return positionRows.parse(rows).map(row => ({ id: row.id, ...(row.t ? { updatedAt: row.t } : {}) }));
}

/** Relationships whose two entities and own provenance the scope can read, by ascending ID. */
export async function scopedRelationshipPositions(db: Database, scope: Scope, query: ListQuery): Promise<ListPosition[]> {
  if (!Number.isInteger(query.limit) || query.limit < 1) throw new DomainError('INVALID_LIST_QUERY', 400);
  const after = query.after === undefined ? undefined : decodeListCursor('id', query.after);
  const id = Prisma.raw('r.id');
  const rows: unknown = await db.$queryRaw`SELECT r.id FROM "Relationship" r
    JOIN "Entity" f ON f.id = r."fromId" JOIN "Entity" t ON t.id = r."toId"
    WHERE f."installationId" = ${scope.installationId} AND t."installationId" = ${scope.installationId}
      AND ${scopeCondition(Prisma.raw(`f.data->'scope'`), scope)} AND ${scopeCondition(Prisma.raw(`t.data->'scope'`), scope)}
      AND ${scopeCondition(Prisma.raw(`r.provenance->'scope'`), scope)}
      ${cursorCondition('id', after, id, id)}
    ${orderBy('id', id, id)} LIMIT ${query.limit + 1}`;
  return positionRows.parse(rows).map(row => ({ id: row.id }));
}

/**
 * Turn positions (one more than the limit when a next page exists) and their loaded items into
 * a page. Items that failed the in-process scope recheck are dropped; the cursor still follows
 * the database positions, so no row is skipped or repeated.
 */
export function listPage<T>(positions: readonly ListPosition[], items: ReadonlyMap<string, T>, query: ListQuery, order: ListOrder): Page<T> {
  const page = positions.slice(0, query.limit); const last = page.at(-1);
  return { data: page.flatMap(position => { const item = items.get(position.id); return item === undefined ? [] : [item]; }), nextCursor: positions.length > query.limit && last ? encodeListCursor(order, last) : null };
}

/** Split IDs into bounded `IN` lists. */
export function chunks<T>(values: readonly T[], size = 1000): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
