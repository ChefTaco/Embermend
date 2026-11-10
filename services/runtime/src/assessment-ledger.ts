import { z } from 'zod';
import { operationRequestSchema, receiptSchema, entitySchema, type OperationRequest, type Receipt, type Entity } from '@hivemagnus/embermend-contracts';
import { digest, json, lock, type Database } from '@hivemagnus/embermend-store';
import { DomainError } from '@hivemagnus/embermend-core';

const entrySchema = z.object({ operationId: z.string(), targetId: z.string().optional(), target: entitySchema.optional(), requestDigest: z.string().optional(), request: operationRequestSchema.optional(), receipt: receiptSchema.optional(), result: z.json().optional() });
type Entry = z.infer<typeof entrySchema>;
export class AssessmentLedger {
  private constructor(private readonly db: Database, private readonly originalId: string, private readonly leaseId: string, private readonly owner: string, private readonly entries: Entry[]) {}
  static async open(db: Database, originalId: string, leaseId: string, owner: string): Promise<AssessmentLedger> {
    const job = await db.job.findUniqueOrThrow({ where: { id: originalId } });
    const entries = job.result === null ? [] : z.object({ operations: z.array(entrySchema) }).parse(job.result).operations;
    if (new Set(entries.map(entry => entry.operationId)).size !== entries.length) throw new DomainError('ASSESSMENT_OPERATION_IDENTITY_CONFLICT');
    return new AssessmentLedger(db, originalId, leaseId, owner, entries);
  }
  get(operationId: string): Entry | undefined { return this.entries.find(entry => entry.operationId === operationId); }
  async reserve(request: OperationRequest, target: Entity): Promise<Entry> {
    if (this.get(request.operationId)) throw new DomainError('ASSESSMENT_OPERATION_ALREADY_RESERVED');
    const entry = { operationId: request.operationId, targetId: request.action.targetId, target, requestDigest: digest(request), request };
    this.entries.push(entry); await this.save(); return entry;
  }
  bind(entry: Entry, targetId: string, receipt: Receipt): void {
    if (!entry.requestDigest || entry.targetId !== targetId || receipt.operationId !== entry.operationId || receipt.requestDigest !== entry.requestDigest || receipt.targetId !== targetId || entry.request && digest(entry.request) !== entry.requestDigest) throw new DomainError('ASSESSMENT_RECEIPT_BINDING');
  }
  async receipt(entry: Entry, targetId: string, receipt: Receipt): Promise<void> { this.bind(entry, targetId, receipt); entry.receipt = receipt; await this.save(); }
  async result(entry: Entry, result: unknown): Promise<void> { entry.result = z.json().parse(result); await this.save(); }
  value() { return { operations: this.entries }; }
  async save(): Promise<void> {
    await this.db.$transaction(async tx => {
      await lock(tx, `assessment-observation:${this.originalId}`);
      const lease = await tx.job.findUnique({ where: { id: this.leaseId } });
      if (!lease || lease.status !== 'running' || lease.leaseOwner !== this.owner || !lease.leaseUntil || lease.leaseUntil <= new Date()) throw new DomainError('WORKER_LEASE_LOST');
      await tx.job.update({ where: { id: this.originalId }, data: { result: json(this.value()) } });
    });
  }
}
