import { timestamp, evidenceSchema, verificationSchema, observationSchema, type Actor, type Evidence, type Finding, type Occurrence } from '@hivemagnus/embermend-contracts';
import { audit, digest, json, within, type Transaction } from '@hivemagnus/embermend-store';
import { DomainError } from './authorization.js';

function capture(item: Evidence): { at: number; identity: string } {
  let at = Date.parse(item.observedAt); let intrinsicTime: string | undefined;
  if (item.source === 'magnus' && Object.hasOwn(item.content, 'observedAt')) {
    const parsed = timestamp.safeParse(item.content['observedAt']); if (!parsed.success) throw new DomainError('HOST_CAPTURE_TIME_REQUIRES_REVIEW');
    intrinsicTime = parsed.data; at = Math.min(at, Date.parse(intrinsicTime));
  }
  return { at, identity: digest([item.source, item.subjectId, item.method, item.scope, item.digest, intrinsicTime ?? item.observedAt]) };
}

/** Old host captures are historical evidence, even inside a new delivery envelope. */
export async function retainHostCapture(tx: Transaction, actor: Actor, finding: Finding, previous: Occurrence, incoming: Occurrence, supplied: ReadonlyMap<string, Evidence>): Promise<boolean> {
  if (!['hardening', 'os-package'].includes(finding.kind) || incoming.sourceState !== 'not-applicable' || previous.runtimeState !== 'verified-resolved' || incoming.runtimeState !== 'affected') return false;
  const rows = await tx.verification.findMany({ where: { occurrenceId: previous.id, AND: [{ data: { path: ['dimension'], equals: 'runtime' } }, { data: { path: ['result'], equals: 'pass' } }] }, orderBy: { createdAt: 'desc' }, take: 1001 });
  if (rows.length > 1000) throw new DomainError('HOST_VERIFICATION_HISTORY_REQUIRES_REVIEW');
  const verified = rows.map(row => ({ row, value: verificationSchema.parse(row.data) })).sort((a, b) => Date.parse(b.value.observedAt) - Date.parse(a.value.observedAt))[0];
  if (!verified) throw new DomainError('VERIFIED_HOST_HISTORY_MISSING');
  if (!incoming.evidenceIds.length) throw new DomainError('HOST_RECURRENCE_CAPTURE_REQUIRED');
  let newestCapture = -Infinity; const identities: string[] = [];
  for (const id of incoming.evidenceIds) {
    const item = supplied.get(id); if (!item || !within(finding.scope, item.scope)) throw new DomainError('FINDING_EVIDENCE_UNAVAILABLE');
    const observed = capture(item); newestCapture = Math.max(newestCapture, observed.at); identities.push(observed.identity);
  }
  const capturedAt = Math.min(Date.parse(incoming.coverage.observedAt), newestCapture);
  // Cross-host clocks alone cannot classify a new capture as historical. It
  // must match a snapshot already retained before the successful verification.
  // An unfamiliar capture requires review rather than losing a possible recurrence.
  const retained = await tx.evidence.findMany({ where: { id: { in: previous.evidenceIds }, createdAt: { lte: verified.row.createdAt } } });
  const matches = new Set(retained.map(row => capture(evidenceSchema.parse(row.data)).identity));
  if (!identities.every(id => matches.has(id))) {
    if (capturedAt > Date.parse(verified.value.observedAt)) return false;
    throw new DomainError('HOST_CAPTURE_ORDER_REQUIRES_REVIEW');
  }
  const id = digest(['historical-host-capture', finding.id, previous.id, incoming.evidenceIds, capturedAt, verified.row.id]);
  if (!await tx.observation.findUnique({ where: { id } })) {
    const observation = observationSchema.parse({ id, scope: finding.scope, subjectId: finding.id, source: 'finding-history', sourceEventId: id, type: 'finding.historical-capture', observedAt: new Date(capturedAt).toISOString(), evidenceIds: incoming.evidenceIds, data: { occurrenceId: previous.id, verificationId: verified.row.id, reason: 'Retained capture delivered after later verification' } });
    await tx.observation.create({ data: { id, source: observation.source, sourceEventId: id, installationId: finding.scope.installationId, subjectId: finding.id, observedAt: new Date(capturedAt), data: json(observation) } });
    await audit(tx, actor, 'finding.historical-capture', finding.id, { observationId: id, verificationId: verified.row.id });
  }
  return true;
}
