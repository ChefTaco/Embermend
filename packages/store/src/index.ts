import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from './generated/client.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scopeSchema, type Actor, type Scope } from '@hivemagnus/embermend-contracts';

export { Prisma };
export type Database = PrismaClient;
export type Transaction = Prisma.TransactionClient;
export function database(url: string): Database {
  const parsed = new URL(url);
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) throw new Error('PostgreSQL is required');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Non-JSON value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = z.record(z.string(), z.unknown()).parse(value);
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function json(value: unknown): Prisma.InputJsonValue { return z.record(z.string(), z.json()).or(z.array(z.json())).parse(value); }
export async function lock(tx: Transaction, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
export async function audit(tx: Transaction, actor: Actor, operation: string, subjectId: string, details: unknown = {}): Promise<void> {
  await tx.audit.create({ data: { id: randomUUID(), actorId: actor.id, operation, subjectId, installationId: actor.scope.installationId, details: json(details) } });
}
export function serializeActor(actor: Actor): Prisma.InputJsonValue { return json({ ...actor, permissions: [...actor.permissions] }); }
export function within(outer: Scope, inner: Scope): boolean {
  return outer.installationId === inner.installationId && inner.applicationIds.every(id => outer.applicationIds.includes(id)) && inner.targetIds.every(id => outer.targetIds.includes(id));
}
export async function enqueue(tx: Transaction, actor: Actor, kind: string, key: string, payload: unknown, deadline: Date): Promise<string> {
  const scoped = z.object({ scope: scopeSchema }).passthrough().safeParse(payload);
  if (scoped.success) { if (!within(actor.scope, scoped.data.scope)) throw new Error('JOB_SCOPE_DENIED'); actor = { ...actor, scope: scoped.data.scope }; }
  const dedupeKey = `${actor.scope.installationId}:${kind}:${key}`;
  await lock(tx, `job:${dedupeKey}`);
  const existing = await tx.job.findUnique({ where: { dedupeKey } });
  if (existing) {
    if (digest(existing.payload) !== digest(payload) || digest(existing.actor) !== digest(serializeActor(actor))) throw new Error('JOB_IDENTITY_CONFLICT');
    return existing.id;
  }
  const id = randomUUID();
  await tx.job.create({ data: { id, kind, installationId: actor.scope.installationId, actor: serializeActor(actor), dedupeKey, payload: json(payload), deadline } });
  return id;
}
const claimedSchema = z.object({ id: z.string() });
export async function claim(db: Database, owner: string): Promise<string | null> {
  return db.$transaction(async tx => {
    // A crashed handler may have changed an external system. Never requeue it.
    await tx.job.updateMany({ where: { status: 'running', leaseUntil: { lt: new Date() } }, data: { status: 'unknown', error: 'WORKER_LEASE_EXPIRED_RECONCILE_ORIGINAL_OPERATION' } });
    await tx.job.updateMany({ where: { status: 'queued', deadline: { lte: new Date() }, result: { equals: Prisma.DbNull } }, data: { status: 'failed', error: 'DEADLINE_EXCEEDED_BEFORE_ADMISSION' } });
    await tx.job.updateMany({ where: { status: 'queued', deadline: { lte: new Date() }, NOT: { result: { equals: Prisma.DbNull } } }, data: { status: 'unknown', error: 'DEADLINE_EXCEEDED_RECONCILE_ORIGINAL_OPERATION' } });
    const rows: unknown = await tx.$queryRaw`SELECT id FROM "Job" WHERE status = 'queued' AND "availableAt" <= NOW() AND deadline > NOW() AND "cancelRequested" = false ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    const row = z.array(claimedSchema).parse(rows)[0];
    if (!row) return null;
    await tx.job.update({ where: { id: row.id }, data: { status: 'running', leaseOwner: owner, leaseUntil: new Date(Date.now() + 60000) } });
    return row.id;
  });
}
