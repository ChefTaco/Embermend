import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, digest, claim, enqueue } from '@hivemagnus/embermend-store';
import { Embermend } from '@hivemagnus/embermend-core';
import { IntegrationError, type Magnus } from '@hivemagnus/embermend-integrations';
import { type OperationRequest, type Receipt } from '@hivemagnus/embermend-contracts';
import { operator, coordinator, target, finding, occurrence, evidence, plan, policy, now, later, scope } from '../fixtures.js';
import { tick } from '../../services/runtime/dist/worker.js';
import { createApi } from '../../services/runtime/dist/api.js';

const url = process.env['DATABASE_URL'];
if (!url || !new URL(url).pathname.startsWith('/embermend_test') || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Explicit loopback embermend_test PostgreSQL database required');
const db = database(url);
class FixtureMagnus implements Magnus {
  requests: OperationRequest[] = []; loseReply = false; receipts = new Map<string, Receipt>();
  async capabilities() { return { protocol: 1 as const, installationId: 'fixture-magnus', serviceVersion: 'fixture', actions: ['file-mode.v1', 'inventory.v1'], targets: [target()], observedAt: now() }; }
  async dispatch(request: OperationRequest): Promise<Receipt> {
    this.requests.push(request);
    const receipt: Receipt = { operationId: request.operationId, requestDigest: digest(request), targetId: request.action.targetId, state: 'completed', evidenceIds: [], result: { exitCode: 0 }, ownershipReleased: true, observedAt: now() };
    this.receipts.set(request.operationId, receipt); if (this.loseReply) throw new IntegrationError('LOST_REPLY', true); return receipt;
  }
  async receipt(id: string): Promise<Receipt> { const receipt = this.receipts.get(id); if (!receipt) throw new IntegrationError('MISSING_RECEIPT', false); return receipt; }
  async scanResult(): Promise<never> { throw new Error('UNSUPPORTED'); }
}
test('PostgreSQL-backed security and execution invariants', async t => {
  t.after(async () => db.$disconnect());
  const reset = async () => {
    const tables = ['Audit', 'Authorization', 'Build', 'Campaign', 'Entity', 'Evidence', 'Exception', 'Execution', 'Finding', 'Job', 'Observation', 'Occurrence', 'Outbox', 'Plan', 'PlanRevision', 'Policy', 'Profile', 'ProfileAssignment', 'Publication', 'Preparation', 'ProviderEffect', 'Relationship', 'RepositoryChange', 'Schedule', 'Verification'];
    for (const name of tables) await db.$executeRawUnsafe(`TRUNCATE TABLE "${name}"`);
    const magnus = new FixtureMagnus(); const service = new Embermend(db, magnus);
    await service.entity(operator, target()); await service.evidence(operator, evidence()); await service.finding(operator, finding(), occurrence());
    return { magnus, service };
  };
  await t.test('explanation and an exact decision are required before mutation', async () => {
    const { service, magnus } = await reset(); const proposed = await service.propose(coordinator, plan());
    await assert.rejects(service.dispatch(coordinator, proposed.id, 'fixture-action'), /PUBLICATION/); assert.equal(magnus.requests.length, 0);
    await service.publish(coordinator, proposed.id, proposed.revision);
    await assert.rejects(service.dispatch(coordinator, proposed.id, 'fixture-action'), /AUTHORIZATION/); assert.equal(magnus.requests.length, 0);
    await service.decide(operator, { planId: proposed.id, revision: proposed.revision, digest: proposed.digest, decision: 'approve', expiresAt: (await service.plan(operator, proposed.id)).expiresAt });
    await service.dispatch(coordinator, proposed.id, 'fixture-action'); await service.dispatch(coordinator, proposed.id, 'fixture-action'); assert.equal(magnus.requests.length, 1);
  });
  await t.test('standing authorization proceeds after publication without acknowledgement', async () => {
    const { service, magnus } = await reset(); const proposed = await service.propose(coordinator, plan()); await service.policy(operator, policy());
    await assert.rejects(service.authorizePolicy(coordinator, proposed.id, 'fixture-policy'), /PUBLICATION/);
    await service.publish(coordinator, proposed.id, proposed.revision); await service.authorizePolicy(coordinator, proposed.id, 'fixture-policy'); await service.dispatch(coordinator, proposed.id, 'fixture-action'); assert.equal(magnus.requests.length, 1);
  });
  await t.test('material revisions and policy revocation invalidate authorization', async () => {
    const { service, magnus } = await reset(); await service.propose(coordinator, plan()); await service.publish(coordinator, 'fixture-plan', 1); await service.policy(operator, policy()); await service.authorizePolicy(coordinator, 'fixture-plan', 'fixture-policy');
    await service.policy(operator, { ...policy(), revision: 2, enabled: false }); await assert.rejects(service.dispatch(coordinator, 'fixture-plan', 'fixture-action'), /AUTHORIZATION/);
    await service.propose(coordinator, { ...plan(), revision: 2, explanation: 'Revised recommendation' }); await assert.rejects(service.decide(operator, { planId: 'fixture-plan', revision: 1, digest: digest(plan()), decision: 'approve', expiresAt: later() }), /STALE/); assert.equal(magnus.requests.length, 0);
  });
  await t.test('pause prevents future dispatch and is authoritative across service instances', async () => {
    const { service, magnus } = await reset(); await service.propose(coordinator, plan()); await service.publish(coordinator, 'fixture-plan', 1); await service.policy(operator, policy()); await service.authorizePolicy(coordinator, 'fixture-plan', 'fixture-policy');
    await service.pause(operator, 'fixture-campaign', true); const other = new Embermend(db, magnus); await assert.rejects(other.dispatch(coordinator, 'fixture-plan', 'fixture-action'), /PAUSED/); assert.equal(magnus.requests.length, 0);
  });
  await t.test('lost reply persists original operation and reconciles without replay', async () => {
    const { service, magnus } = await reset(); await service.propose(coordinator, plan()); await service.publish(coordinator, 'fixture-plan', 1); await service.policy(operator, policy()); await service.authorizePolicy(coordinator, 'fixture-plan', 'fixture-policy'); magnus.loseReply = true;
    await assert.rejects(service.dispatch(coordinator, 'fixture-plan', 'fixture-action'), /UNKNOWN_EXECUTION/);
    const held = await db.execution.findFirstOrThrow(); assert.equal(held.state, 'unknown');
    const restarted = new Embermend(db, magnus); const reconciled = await restarted.dispatch(coordinator, 'fixture-plan', 'fixture-action'); assert.equal(reconciled.state, 'completed'); assert.equal(magnus.requests.length, 1); assert.equal(reconciled.operationId, held.id);
  });
  await t.test('job claims serialize consumers and never replay expired running work', async () => {
    await reset(); const id = await db.$transaction(tx => enqueue(tx, operator, 'fixture', 'one', { fixture: true }, new Date(later())));
    const duplicate = await db.$transaction(tx => enqueue(tx, operator, 'fixture', 'one', { fixture: true }, new Date(later()))); assert.equal(duplicate, id);
    const claims = await Promise.all([claim(db, 'one'), claim(db, 'two')]); assert.equal(claims.filter(Boolean).length, 1);
    await db.job.update({ where: { id }, data: { leaseUntil: new Date(0) } }); assert.equal(await claim(db, 'three'), null); assert.equal((await db.job.findUniqueOrThrow({ where: { id } })).status, 'unknown');
  });
  await t.test('repository rename preserves stable identity and history', async () => {
    const { service } = await reset(); const base = { id: 'repository-one', kind: 'repository', scope, label: 'Fixture repo', provenance: { source: 'github', assurance: 'established', evidenceIds: [], observedAt: now() }, provider: 'github', providerInstance: 'https://github.com', providerId: 'fixture-provider-id', owner: 'fixture-owner', name: 'original', accessRevision: 1 };
    const first = await service.entity(operator, base); const renamed = await service.entity(operator, { ...base, id: 'repository-two', name: 'renamed' }); assert.equal(first.id, renamed.id);
  });
  await t.test('recurrence preserves historical verification and deduplicates repeated rescans', async () => {
    const { service } = await reset();
    const proof = { ...evidence(), id: 'effective-proof', content: { findingIdentity: finding().identity, securityCheckPassed: true, runningStateVerified: true } }; await service.evidence(operator, proof);
    await service.verify(operator, { id: 'effective-verification', occurrenceId: occurrence().id, dimension: 'runtime', result: 'pass', method: proof.method, evidenceIds: [proof.id], coverage: occurrence().coverage, revision: null, artifactDigest: null, targetId: 'fixture-node', healthPassed: true, observedAt: proof.observedAt, independent: true, consumerMigrationVerified: false });
    await service.finding(operator, { ...finding(), validity: 'candidate' }, occurrence()); await service.finding(operator, { ...finding(), validity: 'candidate' }, occurrence());
    const [row] = await service.findings(operator); assert.ok(row); assert.equal(row.finding.validity, 'validated'); assert.equal(row.occurrences.length, 2); assert.equal(row.occurrences.filter(item => item.runtimeState === 'verified-resolved').length, 1); assert.equal(await db.verification.count(), 1);
  });
  await t.test('failed verification pauses the campaign before any further action', async () => {
    const { service } = await reset(); await service.propose(coordinator, plan());
    await service.verify(operator, { id: 'failed-verification', occurrenceId: occurrence().id, dimension: 'runtime', result: 'fail', method: evidence().method, evidenceIds: [evidence().id], coverage: occurrence().coverage, revision: null, artifactDigest: null, targetId: 'fixture-node', healthPassed: false, observedAt: now(), independent: true, consumerMigrationVerified: false });
    assert.equal((await db.campaign.findUnique({ where: { id: plan().campaignId } }))?.paused, true);
  });
  await t.test('profile assignments retain impact and cannot silently change versions', async () => {
    const { service } = await reset(); await service.profile(operator, { id: 'permissions', version: '1', platform: 'ubuntu-24.04', rules: [{ id: 'permissions', explanation: 'Protect approved configuration', capability: 'inventory.v1', field: 'configuration.mode', expected: '0600', actionVersion: 'file-mode.v1' }] });
    const assignment = { id: 'profile-assignment', scope, profileId: 'permissions', profileVersion: '1', targetIds: ['fixture-node'], impact: 'Read effective permissions before proposing a separately authorized change', supersedes: null };
    await service.records.assignment(operator, assignment); await assert.rejects(service.records.assignment(operator, { ...assignment, impact: 'Changed' }), /IMMUTABLE/);
    assert.equal((await service.records.assignments(operator))[0]?.impact, assignment.impact);
  });
  await t.test('historical evidence and published revisions are append only in PostgreSQL', async () => {
    const { service } = await reset(); await service.propose(coordinator, plan()); await service.publish(coordinator, plan().id, 1);
    await assert.rejects(db.evidence.update({ where: { id: evidence().id }, data: { data: {} } }), /append only/);
    await assert.rejects(db.planRevision.delete({ where: { planId_revision: { planId: plan().id, revision: 1 } } }), /append only/);
    assert.ok(await db.observation.count());
  });
  await t.test('execution requests bind the displayed revision before enqueuing work', async () => {
    const { service } = await reset(); const value = await service.propose(coordinator, plan());
    await assert.rejects(service.execute(coordinator, value.id, { revision: value.revision + 1, digest: value.digest }), /STALE_EXECUTION/);
    assert.equal(await db.job.count(), 0);
  });
  await t.test('API denies anonymous and coordinator approval requests', async () => {
    const { service } = await reset(); const app = createApi(service, async token => { if (token !== 'fixture-coordinator-token') throw new Error('invalid'); return coordinator; });
    assert.equal((await app.request('/api/v1/findings')).status, 401);
    await service.propose(coordinator, plan()); await service.publish(coordinator, 'fixture-plan', 1);
    const response = await app.request('/api/v1/decisions', { method: 'POST', headers: { authorization: 'Bearer fixture-coordinator-token', 'content-type': 'application/json' }, body: JSON.stringify({ planId: 'fixture-plan', revision: 1, digest: digest(await service.plan(operator, 'fixture-plan')), decision: 'approve', expiresAt: later() }) }); assert.equal(response.status, 403);
  });
  await t.test('a transient unknown receipt is observed under its original operation without another dispatch', async () => {
    const { service, magnus } = await reset();
    await service.profile(operator, { id: 'transient-profile', version: '1', platform: 'ubuntu-24.04', rules: [{ id: 'observed', explanation: 'Observe the fixture configuration', capability: 'inventory.v1', field: 'mode', expected: '0600', actionVersion: 'file-mode.v1' }] });
    let observations = 0; const seen = new Map<string, number>();
    const node = target(); assert.equal(node.kind, 'target'); if (node.kind !== 'target') throw new Error('Target fixture required');
    const cohort = { ...scope, targetIds: ['fixture-node', 'fixture-other'] }; const assessor = { ...operator, scope: cohort };
    magnus.capabilities = async () => ({ protocol: 1, installationId: 'fixture-magnus', serviceVersion: 'fixture', actions: ['file-mode.v1', 'inventory.v1'], targets: [node, { ...node, id: 'fixture-other', magnusTargetId: 'fixture-other', scope: { ...scope, targetIds: ['fixture-other'] } }], observedAt: now() });
    magnus.dispatch = async request => {
      magnus.requests.push(request);
      const receipt: Receipt = { operationId: request.operationId, requestDigest: digest(request), targetId: request.action.targetId, state: 'queued', evidenceIds: [], result: {}, ownershipReleased: false, observedAt: now() };
      magnus.receipts.set(request.operationId, receipt); return receipt;
    };
    magnus.receipt = async id => { const retained = magnus.receipts.get(id); assert.ok(retained); observations++; const count = (seen.get(id) ?? 0) + 1; seen.set(id, count); return { ...retained, state: count === 1 ? 'unknown' : 'completed', ownershipReleased: count > 1, result: { mode: '0644' }, observedAt: now() }; };
    const id = await service.assess(assessor, { id: 'transient-assessment', scope: cohort, targetIds: cohort.targetIds, profileId: 'transient-profile', profileVersion: '1', deadline: later() });
    await tick(service, 'fixture-worker', AbortSignal.timeout(10000));
    assert.equal((await service.job(assessor, id)).status, 'completed'); assert.equal(magnus.requests.length, 2); assert.equal(observations, 4);
    const observed = (await service.findings(assessor)).filter(row => row.finding.weakness === 'observed'); assert.equal(observed.length, 2); for (const row of observed) assert.deepEqual(row.finding.scope.targetIds, [row.finding.component]);
  });

  await t.test('restricted evidence requires its own scoped permission', async () => {
    const { service } = await reset(); await service.evidence(operator, { ...evidence(), id: 'restricted-proof', sensitivity: 'restricted' });
    const reader = { ...operator, permissions: new Set(['evidence'] as const) };
    assert.equal((await service.readEvidence(reader, evidence().id)).sensitivity, 'ordinary');
    await assert.rejects(service.readEvidence(reader, 'restricted-proof'), /SCOPE_OR_PERMISSION_DENIED/);
    assert.equal((await service.readEvidence(operator, 'restricted-proof')).sensitivity, 'restricted');
  });

  await t.test('a scoped integration cannot replace another target finding by guessing its identity', async () => {
    const { service } = await reset(); const otherScope = { ...scope, targetIds: ['fixture-other'] }; const scoped = { ...operator, kind: 'integration' as const, scope: otherScope };
    await service.evidence(scoped, { ...evidence(), id: 'other-proof', scope: otherScope, subjectId: 'fixture-other' });
    await assert.rejects(service.finding(scoped, { ...finding(), scope: otherScope, component: 'fixture-other', evidenceIds: ['other-proof'] }, { ...occurrence(), id: 'other-occurrence', subjectId: 'fixture-other', evidenceIds: ['other-proof'] }), /EXISTING_FINDING_OUTSIDE_SCOPE/);
    assert.equal((await service.findings(operator))[0]?.finding.component, 'fixture-node');
  });

});
