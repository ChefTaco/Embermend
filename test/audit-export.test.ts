import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_EXPORT_PATH, AUDIT_READ_PERMISSION, hiveAuditRecordSchema, hiveAuditPageSchema, type Actor } from '@hivemagnus/embermend-contracts';
import { auditAction, auditDetails, auditExportInstallation, auditRecord, type ExportedAuditRow } from '@hivemagnus/embermend-core';
import { inferenceProviderSchema, NetworkInference, networkBaseUrl } from '@hivemagnus/embermend-integrations';
import { scope } from './fixtures.js';

const row = (change: Partial<ExportedAuditRow> = {}): ExportedAuditRow => ({ id: '00000000-0000-4000-8000-000000000001', actorId: 'fixture-operator', actorKind: 'operator', operation: 'plan.approve', subjectId: 'fixture-plan', installationId: 'fixture-installation', details: { decisionId: 'fixture-decision', revision: 1 }, createdAt: new Date('2026-11-12T10:00:00.000Z'), ...change });

test('audit export path and permission are the documented ones', () => {
  assert.equal(AUDIT_EXPORT_PATH, '/api/v1/audit/export');
  assert.equal(AUDIT_READ_PERMISSION, 'embermend:audit:read');
});

test('an audit row maps to a strict HiveAuditRecord with a stable ID', () => {
  const record = auditRecord(row());
  assert.deepEqual(record, { id: 'embermend:audit:00000000-0000-4000-8000-000000000001', product: 'embermend', occurredAt: '2026-11-12T10:00:00.000Z', action: 'plan.approve', outcome: 'success', actor: { type: 'user', id: 'fixture-operator' }, target: { type: 'plan', id: 'fixture-plan' }, details: { installationId: 'fixture-installation', decisionId: 'fixture-decision', revision: 1 } });
  assert.deepEqual(auditRecord(row()), record);
  assert.deepEqual(hiveAuditRecordSchema.parse(record), record);
  assert.equal(hiveAuditRecordSchema.safeParse({ ...record, extra: true }).success, false);
  assert.equal(hiveAuditRecordSchema.safeParse({ ...record, details: { nested: { a: 1 } } }).success, false);
  assert.equal(hiveAuditPageSchema.safeParse({ data: [record], nextCursor: null }).success, true);
});

test('actions are dotted lowercase and actors, targets and outcomes follow the row', () => {
  assert.equal(auditAction('plan.policy-authorized'), 'plan.policy_authorized');
  assert.equal(auditAction('provider.pull-request.observed'), 'provider.pull_request.observed');
  assert.equal(auditRecord(row({ actorId: 'worker:job-1', actorKind: 'integration' })).actor.type, 'system');
  assert.equal(auditRecord(row({ actorKind: 'coordinator' })).actor.type, 'service');
  assert.equal(auditRecord(row({ actorKind: null }), () => 'operator').actor.type, 'user');
  assert.equal(auditRecord(row({ actorKind: null }), () => undefined).actor.type, 'service');
  assert.equal(auditRecord(row({ operation: 'execution.receipt', details: { state: 'failed' } })).outcome, 'failure');
  assert.equal(auditRecord(row({ operation: 'execution.receipt', details: { state: 'completed' } })).outcome, 'success');
  assert.equal(auditRecord(row({ operation: 'verification.recorded', details: { result: 'fail' } })).outcome, 'failure');
  assert.deepEqual(auditRecord(row({ operation: 'provider.merge.observed' })).target, { type: 'execution', id: 'fixture-plan' });
  assert.deepEqual(auditRecord(row({ operation: 'provider.effect.reserved' })).target?.type, 'provider-effect');
});

test('details keep only flat identifiers, drop free text and secrets, and fit 4 KB', () => {
  const details = auditDetails({ installationId: 'fixture-installation', details: { impact: 'Operator-written impact text', editPaths: ['src/a.ts'], nested: { token: 'x' }, apiToken: 'fixture-not-a-real-token', note: 'Authorization: Bearer abcdefghijklmnop', reason: 'NO_PROVIDER_MUTATION_RESERVED', requestDigest: 'a'.repeat(64) } });
  assert.equal('impact' in details, false); assert.equal('editPaths' in details, false); assert.equal('nested' in details, false);
  assert.equal(details['apiToken'], '[REDACTED]');
  assert.equal(String(details['note']).includes('abcdefghijklmnop'), false);
  assert.equal(details['reason'], 'NO_PROVIDER_MUTATION_RESERVED');
  assert.equal(auditDetails({ installationId: 'i', details: { reason: 'free text from someone' } })['reason'], undefined);
  const large = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${String(index).padStart(3, '0')}`, 'v'.repeat(1000)]));
  const bounded = auditDetails({ installationId: 'i', details: large });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 4096);
  assert.ok(hiveAuditRecordSchema.safeParse(auditRecord(row({ details: large }))).success);
});

test('only audit:read grants export; services export every installation, operators their own', () => {
  const reader = (kind: Actor['kind'], permissions: Actor['permissions']): Actor => ({ id: 'fixture', kind, permissions, scope });
  assert.equal(auditExportInstallation(reader('integration', new Set(['audit:read']))), null);
  assert.equal(auditExportInstallation(reader('coordinator', new Set(['audit:read']))), null);
  assert.equal(auditExportInstallation(reader('operator', new Set(['audit:read']))), scope.installationId);
  assert.throws(() => auditExportInstallation(reader('operator', new Set(['read', 'approve']))), /SCOPE_OR_PERMISSION_DENIED/);
});

test('the emberpath preset is an opt-in openai-compatible alias with Emberpath defaults', async () => {
  const preset = inferenceProviderSchema.parse({ kind: 'emberpath', model: 'fixture-model', url: 'https://router.example.com/' });
  assert.equal(preset.kind, 'emberpath'); if (preset.kind !== 'emberpath') throw new Error('fixture');
  assert.equal(preset.ref, 'emberpath'); assert.equal(preset.tokenEnv, 'EMBERPATH_API_KEY'); assert.equal(preset.maxOutputTokens, 8192);
  assert.equal(networkBaseUrl(preset), 'https://router.example.com/v1');
  for (const url of ['http://router.example.com', 'https://user:password@router.example.com', 'https://router.example.com/?a=1']) assert.equal(inferenceProviderSchema.safeParse({ kind: 'emberpath', model: 'm', url }).success, false);
  assert.equal(inferenceProviderSchema.safeParse({ kind: 'emberpath', model: 'm', url: 'https://router.example.com', baseUrl: 'https://other.example.com' }).success, false);
  const calls: { url: string; authorization: string | null; body: unknown }[] = [];
  const fake: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers); calls.push({ url: String(input), authorization: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) as unknown : null });
    if (String(input).endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] });
    return Response.json({ model: 'fixture-model', choices: [{ finish_reason: 'stop', message: { content: '{"candidates":[]}' } }] });
  };
  const model = new NetworkInference(preset, { EMBERPATH_API_KEY: 'fixture-emberpath-key' }, fake);
  assert.equal(model.local, false);
  assert.deepEqual(await model.analyze('system', 'source', AbortSignal.timeout(10000)), { candidates: [] });
  assert.deepEqual(calls.map(call => call.url), ['https://router.example.com/v1/models', 'https://router.example.com/v1/chat/completions']);
  assert.ok(calls.every(call => call.authorization === 'Bearer fixture-emberpath-key'));
  assert.equal(JSON.stringify(calls[1]?.body).includes('"json_schema"'), true);
  await assert.rejects(new NetworkInference(preset, {}, fake).analyze('system', 'source', AbortSignal.timeout(10000)), /MODEL_CREDENTIAL_UNAVAILABLE/);
});
