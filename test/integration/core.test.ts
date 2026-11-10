import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, digest, claim, enqueue } from '@hivemagnus/embermend-store';
import { Embermend } from '@hivemagnus/embermend-core';
import { IntegrationError, GitHubClient, type Magnus } from '@hivemagnus/embermend-integrations';
import { type OperationRequest, type Receipt, type Plan } from '@hivemagnus/embermend-contracts';
import { operator, coordinator, target, finding, occurrence, evidence, plan, policy, now, later, scope } from '../fixtures.js';
import { tick } from '../../services/runtime/dist/worker.js';
import { AssessmentLedger } from '../../services/runtime/dist/assessment-ledger.js';
import { createApi } from '../../services/runtime/dist/api.js';

const url = process.env['DATABASE_URL'];
if (!url || !new URL(url).pathname.startsWith('/embermend_test') || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Explicit loopback embermend_test PostgreSQL database required');
const db = database(url);
class FixtureMagnus implements Magnus {
  requests: OperationRequest[] = []; loseReply = false; receipts = new Map<string, Receipt>(); capabilitiesAvailable = true; observations = 0;
  async capabilities() { if (!this.capabilitiesAvailable) throw new Error('Fixture inventory outage'); return { protocol: 1 as const, installationId: 'fixture-magnus', serviceVersion: 'fixture', actions: ['file-mode.v1', 'inventory.v1'], targets: [target()], observedAt: now() }; }
  async dispatch(request: OperationRequest): Promise<Receipt> {
    this.requests.push(request);
    const receipt: Receipt = { operationId: request.operationId, requestDigest: digest(request), targetId: request.action.targetId, state: 'completed', evidenceIds: [], result: { exitCode: 0 }, ownershipReleased: true, observedAt: now() };
    this.receipts.set(request.operationId, receipt); if (this.loseReply) throw new IntegrationError('LOST_REPLY', true); return receipt;
  }
  async receipt(id: string): Promise<Receipt> { this.observations++; const receipt = this.receipts.get(id); if (!receipt) throw new IntegrationError('MISSING_RECEIPT', false); return receipt; }
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
    await service.finding(operator, { ...finding(), validity: 'candidate' }, occurrence());
    assert.equal(await db.occurrence.count(), 1, 'replaying original evidence preserves later verification');
    const fresh = { ...evidence(), id: 'new-assessment-evidence', observedAt: now() }; await service.evidence(operator, fresh);
    await service.finding(operator, { ...finding(), validity: 'candidate', evidenceIds: [fresh.id] }, { ...occurrence(), evidenceIds: [fresh.id] }); await service.finding(operator, { ...finding(), validity: 'candidate', evidenceIds: [fresh.id] }, { ...occurrence(), evidenceIds: [fresh.id] });
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
    await assert.rejects(service.finding(scoped, { ...finding(), id: 'other-delivery-id', scope: otherScope, component: 'fixture-other', evidenceIds: ['other-proof'] }, { ...occurrence(), id: 'other-occurrence', findingId: 'other-delivery-id', subjectId: 'fixture-other', evidenceIds: ['other-proof'] }), /EXISTING_FINDING_OUTSIDE_SCOPE/);
    assert.equal((await service.findings(operator))[0]?.finding.component, 'fixture-node');
  });

  await t.test('primary finding IDs and stable inventory identities retain their original scope', async () => {
    const { service } = await reset(); const otherScope = { ...scope, targetIds: ['fixture-other'] }; const scoped = { ...operator, scope: otherScope };
    await service.evidence(scoped, { ...evidence(), id: 'other-proof', scope: otherScope, subjectId: 'fixture-other' });
    await assert.rejects(service.finding(scoped, { ...finding(), identity: 'b'.repeat(64), scope: otherScope, component: 'fixture-other', evidenceIds: ['other-proof'] }, { ...occurrence(), id: 'other-occurrence', subjectId: 'fixture-other', evidenceIds: ['other-proof'] }), /SCOPE_OR_PERMISSION_DENIED/);
    await assert.rejects(service.entity(scoped, { ...target(), scope: otherScope, label: 'Attempted reassignment' }), /SCOPE_OR_PERMISSION_DENIED/);
    await assert.rejects(service.finding(operator, { ...finding(), component: 'different-component' }, occurrence()), /FINDING_MATCH_REQUIRES_REVIEW/);
    assert.equal((await service.findings(operator))[0]?.finding.component, 'fixture-node'); assert.equal((await service.entities(operator))[0]?.label, target().label);
  });
  await t.test('a scoped operator cannot take over another plan, policy or campaign', async () => {
    const { service } = await reset(); await service.propose(operator, plan()); await service.policy(operator, policy());
    const otherScope = { ...scope, targetIds: ['fixture-other'] }; const scoped = { ...operator, scope: otherScope };
    await service.evidence(scoped, { ...evidence(), id: 'other-proof', scope: otherScope, subjectId: 'fixture-other' });
    await service.finding(scoped, { ...finding(), id: 'other-finding', identity: 'b'.repeat(64), scope: otherScope, component: 'fixture-other', evidenceIds: ['other-proof'] }, { ...occurrence(), id: 'other-occurrence', findingId: 'other-finding', subjectId: 'fixture-other', evidenceIds: ['other-proof'] });
    const attempted = { ...plan(), scope: otherScope, revision: 2, findingIds: ['other-finding'], evidenceIds: ['other-proof'], canaryTargetId: 'fixture-other', actions: plan().actions.map(action => ({ ...action, targetId: 'fixture-other' })) };
    await assert.rejects(service.propose(scoped, attempted), /SCOPE_OR_PERMISSION_DENIED/);
    await assert.rejects(service.propose(scoped, { ...attempted, id: 'other-plan', revision: 1 }), /SCOPE_OR_PERMISSION_DENIED/);
    await assert.rejects(service.policy(scoped, { ...policy(), scope: otherScope, revision: 2 }), /SCOPE_OR_PERMISSION_DENIED/);
    assert.equal((await db.plan.findUniqueOrThrow({ where: { id: plan().id } })).currentRevision, 1); assert.equal(await db.plan.count(), 1); assert.equal((await db.policy.findUniqueOrThrow({ where: { id: policy().id } })).revision, 1);
  });
  await t.test('concurrent deliveries cannot replace the immutable identity of one finding ID', async () => {
    const { service } = await reset();
    const outcomes = await Promise.allSettled(['b', 'c'].map(marker => service.finding(operator, { ...finding(), id: 'shared-finding-id', identity: marker.repeat(64) }, { ...occurrence(), id: 'concurrent-' + marker, findingId: 'shared-finding-id' })));
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const retained = await db.finding.findUniqueOrThrow({ where: { id: 'shared-finding-id' } }); assert.equal(retained.identity, retained.data && typeof retained.data === 'object' && !Array.isArray(retained.data) ? retained.data['identity'] : null);
  });

  const interruptedAssessment = async () => {
    const setup = await reset();
    await setup.service.profile(operator, { id: 'fixture-inventory', version: '1', platform: 'ubuntu-24.04', rules: [{ id: 'fixture-rule', explanation: 'Retain original inventory', capability: 'inventory.v1', field: 'exitCode', expected: 1, actionVersion: null }] });
    const id = await setup.service.assess(operator, { id: 'fixture-interrupted-assessment', scope, targetIds: ['fixture-node'], profileId: 'fixture-inventory', profileVersion: '1', deadline: later() });
    setup.magnus.loseReply = true; await tick(setup.service, 'fixture-first-worker', AbortSignal.timeout(5000));
    assert.equal((await setup.service.job(operator, id)).status, 'unknown'); assert.equal(setup.magnus.requests.length, 1);
    return { ...setup, id };
  };
  await t.test('expired canceled assessment observes its original receipt without dispatch or fresh inventory', async () => {
    const { service, magnus, id } = await interruptedAssessment();
    const deadline = new Date(Date.now() - 1000); await db.job.update({ where: { id }, data: { deadline } }); await service.cancelJob(operator, id);
    const observer = { ...operator, id: 'fixture-recovery-reader', permissions: new Set(['read', 'recover', 'evidence'] as const) };
    magnus.capabilitiesAvailable = false;
    const observationId = await service.reconcileJob(observer, id); assert.notEqual(observationId, id); assert.equal(await service.reconcileJob(observer, id), observationId);
    assert.equal((await service.job(operator, id)).status, 'unknown'); await tick(service, 'fixture-observer', AbortSignal.timeout(5000));
    const original = await service.job(operator, id); assert.equal(original.status, 'completed'); assert.equal(original.cancelRequested, true); assert.equal(original.deadline, deadline.toISOString());
    assert.equal((await service.job(observer, observationId)).status, 'completed'); assert.equal(magnus.requests.length, 1); assert.equal(magnus.observations, 1);
    await assert.rejects(service.job({ ...observer, permissions: new Set(['read']) }, observationId), /SCOPE_OR_PERMISSION_DENIED/);
    await assert.rejects(service.reconcileJob(observer, id), /NOT_ELIGIBLE/);
    const rows = await db.evidence.findMany({ where: { subjectId: 'fixture-node' } }); assert.equal(rows.length, 2);
  });
  await t.test('observation with no retained operation cannot dispatch an unstarted target', async () => {
    const { service, magnus } = await reset(); const id = await service.assess(operator, { id: 'fixture-never-admitted', scope, targetIds: ['fixture-node'], profileId: 'fixture-inventory', profileVersion: '1', deadline: later() });
    await db.job.update({ where: { id }, data: { status: 'unknown', deadline: new Date(0) } });
    const observed = await service.reconcileJob(operator, id); await tick(service, 'fixture-read-only', AbortSignal.timeout(5000));
    assert.equal((await service.job(operator, observed)).error, 'ORIGINAL_OPERATION_NOT_RETAINED'); assert.equal((await service.job(operator, id)).status, 'unknown'); assert.equal(magnus.requests.length, 0); assert.equal(magnus.observations, 0);
  });
  await t.test('receipt binding mismatch preserves unknown ownership and the original request', async () => {
    const { service, magnus, id } = await interruptedAssessment(); const receipt = [...magnus.receipts.values()][0]; assert.ok(receipt);
    magnus.receipts.set(receipt.operationId, { ...receipt, requestDigest: 'f'.repeat(64) }); const retained = (await service.job(operator, id)).result;
    const observed = await service.reconcileJob(operator, id); await tick(service, 'fixture-binding-check', AbortSignal.timeout(5000));
    assert.equal((await service.job(operator, observed)).error, 'ASSESSMENT_RECEIPT_BINDING'); assert.equal((await service.job(operator, id)).status, 'unknown'); assert.deepEqual((await service.job(operator, id)).result, retained); assert.equal(magnus.requests.length, 1);
  });
  await t.test('failed work remains unknown until original ownership is released', async () => {
    const { service, magnus, id } = await interruptedAssessment(); const receipt = [...magnus.receipts.values()][0]; assert.ok(receipt);
    magnus.receipts.set(receipt.operationId, { ...receipt, state: 'failed', ownershipReleased: false });
    const first = await service.reconcileJob(operator, id); await tick(service, 'fixture-held-failure', AbortSignal.timeout(5000));
    assert.equal((await service.job(operator, first)).status, 'unknown'); assert.equal((await service.job(operator, id)).status, 'unknown');
    magnus.receipts.set(receipt.operationId, { ...receipt, state: 'failed', ownershipReleased: true });
    const second = await service.reconcileJob(operator, id); assert.notEqual(first, second); await tick(service, 'fixture-released-failure', AbortSignal.timeout(5000));
    assert.equal((await service.job(operator, id)).status, 'failed'); assert.equal(magnus.requests.length, 1);
  });
  await t.test('a stale worker cannot persist a receipt after lease expiry', async () => {
    const { service, magnus, id } = await interruptedAssessment(); const request = magnus.requests[0]; assert.ok(request);
    await db.job.update({ where: { id }, data: { status: 'running', leaseOwner: 'fixture-stale-worker', leaseUntil: new Date(0) } });
    const ledger = await AssessmentLedger.open(db, id, id, 'fixture-stale-worker'); const entry = ledger.get(request.operationId); assert.ok(entry);
    const original = (await service.job(operator, id)).result; const receipt = magnus.receipts.get(request.operationId); assert.ok(receipt);
    await assert.rejects(ledger.receipt(entry, request.action.targetId, receipt), /WORKER_LEASE_LOST/);
    assert.deepEqual((await service.job(operator, id)).result, original);
  });
  await t.test('cancellation only confirms queued work with no retained effect', async () => {
    const { service } = await reset();
    for (const retained of [false, true]) {
      const id = await db.$transaction(tx => enqueue(tx, operator, 'assessment', 'fixture-cancel-' + retained, { scope }, new Date(later())));
      if (retained) await db.job.update({ where: { id }, data: { result: { operations: [{ operationId: 'fixture-possible-effect' }] } } });
      await service.cancelJob(operator, id); const job = await service.job(operator, id); assert.equal(job.cancelRequested, true); assert.equal(job.status, retained ? 'unknown' : 'canceled');
    }
    assert.equal(await claim(db, 'fixture-after-cancel'), null);
  });
  await t.test('expired queued jobs with retained effects stay unknown', async () => {
    await reset(); const id = await db.$transaction(tx => enqueue(tx, operator, 'assessment', 'retained-expired', { scope }, new Date(0)));
    await db.job.update({ where: { id }, data: { result: { operations: [{ operationId: 'fixture-held-effect' }] } } }); assert.equal(await claim(db, 'fixture-expiry'), null);
    assert.equal((await db.job.findUniqueOrThrow({ where: { id } })).status, 'unknown');
  });

  await t.test('lost PR creation reply adopts one original PR through reads without repeating provider mutations', async () => {
    const { magnus, service: records } = await reset(); const base = 'a'.repeat(40); const head = 'b'.repeat(40); const tree = 'd'.repeat(40);
    const changeId = 'fixture-lost-pr'; const branch = 'embermend/' + changeId; const writes: string[] = []; let changed = false; let holdResolve = false; const readStarted = Promise.withResolvers<void>(); const readGate = Promise.withResolvers<void>();
    const fake: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url)); const path = parsed.pathname; const method = init?.method ?? 'GET';
      if (path.startsWith('/repositories/')) return Response.json({ id: 123, full_name: 'fixture-owner/fixture-repository', owner: { login: 'fixture-owner' }, name: 'fixture-repository', default_branch: 'main' });
      if (method === 'POST') {
        writes.push(path);
        if (path.endsWith('/git/trees')) return Response.json({ sha: tree });
        if (path.endsWith('/git/commits')) return Response.json({ sha: head });
        if (path.endsWith('/git/refs')) return Response.json({ ref: 'refs/heads/' + branch, object: { sha: head } });
        if (path.endsWith('/pulls')) throw new IntegrationError('FIXTURE_LOST_PULL_REPLY', true);
      }
      if (path.includes('/commits/')) { if (holdResolve) { readStarted.resolve(); await readGate.promise; } return Response.json({ sha: base, commit: { tree: { sha: tree } } }); }
      if (path.includes('/git/ref/')) return Response.json({ ref: 'refs/heads/' + branch, object: { type: 'commit', sha: changed ? 'f'.repeat(40) : head } });
      if (path.endsWith('/pulls')) return Response.json([{ number: 9, html_url: 'https://github.com/fixture-owner/fixture-repository/pull/9', state: 'open', body: 'Operation: ' + changeId, head: { ref: branch, sha: head, repo: { id: 123 } }, base: { ref: 'main', repo: { id: 123 } } }]);
      throw new Error('Unexpected fixture request');
    };
    const service = new Embermend(db, magnus, new GitHubClient('fixture-token-not-real', [{ providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', allowedBranches: ['main'], workflowIds: [] }], fake));
    await records.entity(operator, { id: 'fixture-repository', kind: 'repository', scope, label: 'Fixture repository', provenance: { source: 'github', assurance: 'established', evidenceIds: [], observedAt: now() }, provider: 'github', providerInstance: 'https://github.com', providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', environment: 'lab', accessRevision: 1 });
    await records.evidence(operator, { ...evidence(), id: 'source-proof', subjectId: 'fixture-repository' });
    await records.finding(operator, { ...finding(), id: 'source-finding', identity: 'c'.repeat(64), kind: 'code', component: 'fixture-app', weakness: 'injection', evidenceIds: ['source-proof'] }, { ...occurrence(), id: 'source-occurrence', findingId: 'source-finding', subjectId: 'fixture-repository', branch: 'main', revision: base, sourceState: 'open', runtimeState: 'unknown', evidenceIds: ['source-proof'] });
    const edits = [{ path: 'apps/api/index.ts', beforeDigest: 'a'.repeat(64), content: 'fixture repaired source' }]; const patchDigest = digest(edits);
    const preparation = { id: changeId, repositoryId: 'fixture-repository', applicationId: 'fixture-app', providerId: '123', scope, baseCommit: base, branch: 'main', workerTargetId: 'fixture-node', includedPaths: ['apps/api'], excludedPaths: [], edits, validationProfileId: 'fixture-validation', deadline: later() };
    const prepared = { preparationId: preparation.id, baseCommit: base, patchDigest, validated: true, edits, validationEvidence: { method: 'fixture-test' }, coverage: { status: 'complete', requested: ['apps/api/index.ts'], examined: ['apps/api/index.ts'], excluded: [], failures: [], mode: 'incremental', observedAt: now() } };
    await db.preparation.create({ data: { id: changeId, installationId: scope.installationId, repositoryId: preparation.repositoryId, applicationId: preparation.applicationId, jobId: 'fixture-preparation-job', requestDigest: digest(preparation), data: preparation, result: prepared } });
    const value: Plan = { ...plan(), id: 'fixture-pr-plan', campaignId: 'fixture-pr-campaign', findingIds: ['source-finding'], evidenceIds: ['source-proof'], canaryTargetId: 'fixture-repository', actions: [{ ...plan().actions[0], id: 'open-fix', version: 'repository-pr.v1', class: 'repository-write', targetId: 'fixture-repository', targetKind: 'repository', requiredCapabilities: ['embermend:repository-pr.v1'], parameters: { changeId, repositoryId: 'fixture-repository', baseCommit: base, patchDigest }, preconditions: { environment: 'lab', branch: 'main' }, dependsOn: [], verificationIds: ['source-check'], recovery: 'Separate source recovery approval required', expectedRevision: base, patchDigest, disruption: 'none' }] };
    const unstarted = { ...value, id: 'fixture-held-read-plan', campaignId: 'fixture-held-read-campaign' };
    const admitted = await service.propose(operator, unstarted); await service.publish(operator, unstarted.id, 1); await service.decide(operator, { planId: unstarted.id, revision: 1, digest: admitted.digest, decision: 'approve', expiresAt: unstarted.expiresAt });
    holdResolve = true; const delayed = service.dispatch(operator, unstarted.id, 'open-fix'); const delayedRefusal = assert.rejects(delayed, /PROVIDER_EXECUTION_NOT_ADMITTED/); await readStarted.promise;
    const reserved = await db.execution.findFirstOrThrow({ where: { planId: unstarted.id } });
    assert.equal((await service.reconcile({ ...operator, permissions: new Set(['read']) }, reserved.id)).state, 'unknown');
    const notDispatched = await service.reconcile(operator, reserved.id); assert.equal(notDispatched.state, 'not-dispatched'); assert.equal(notDispatched.ownershipReleased, true);
    holdResolve = false; readGate.resolve(); await delayedRefusal; assert.equal(writes.length, 0); assert.equal(await db.providerEffect.count(), 0);
    assert.deepEqual(await service.dispatch(operator, unstarted.id, 'open-fix'), notDispatched);
    const proposed = await service.propose(operator, value); await service.publish(operator, value.id, 1); await service.decide(operator, { planId: value.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: value.expiresAt });
    await assert.rejects(service.dispatch(operator, value.id, 'open-fix'), /FIXTURE_LOST_PULL_REPLY/); assert.equal(writes.length, 4);
    const original = await db.execution.findFirstOrThrow({ where: { planId: value.id } }); assert.equal(original.state, 'unknown'); assert.equal(await db.repositoryChange.count(), 0);
    changed = true; await assert.rejects(service.reconcile(operator, original.id), /BRANCH_HEAD_CHANGED/); assert.equal((await db.execution.findUniqueOrThrow({ where: { id: original.id } })).state, 'unknown');
    changed = false; const receipt = await service.reconcile(operator, original.id); assert.equal(receipt.state, 'completed'); assert.equal(receipt.ownershipReleased, true); assert.equal(receipt.result['headCommit'], head);
    assert.deepEqual(await service.reconcile(operator, original.id), receipt); await service.dispatch(operator, value.id, 'open-fix'); assert.equal(writes.length, 4); assert.equal(await db.repositoryChange.count(), 1);
  });

  await t.test('merge request UUID survives queueing and read-only reconciliation without another provider mutation', async () => {
    const { magnus, service: records } = await reset();
    const base = 'a'.repeat(40); const head = 'b'.repeat(40); const mergedCommit = 'c'.repeat(40); const requestId = '630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42';
    let phase = 'pending'; let writes = 0;
    const checks = { total_count: 1, check_runs: [{ id: 1, name: 'Verify', head_sha: head, status: 'completed', conclusion: 'success' }] };
    const fake: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.startsWith('/repositories/')) return Response.json({ id: 123, full_name: 'fixture-owner/fixture-repository', owner: { login: 'fixture-owner' }, name: 'fixture-repository', default_branch: 'main' });
      if (path.endsWith('/check-runs')) return Response.json(checks);
      if (path === '/graphql') return Response.json({ data: { repository: { databaseId: 123, nameWithOwner: 'fixture-owner/fixture-repository', viewerPermission: 'ADMIN', pullRequest: { headRefOid: head, baseRefName: 'main', baseRefOid: base, isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null } } } });
      if (init?.method === 'PUT') { writes++; assert.equal(JSON.stringify(JSON.parse(String(init.body))), JSON.stringify({ sha: head, merge_method: 'squash', merge_action: 'default', bypass_rules: false })); return Response.json({ status: 'pending', details: { uuid: requestId, expected_head_sha: head, merge_method: 'squash', merge_action: 'default', bypass_rules: false } }, { status: 202 }); }
      if (path.includes('/merge-async/')) return Response.json(phase === 'pending' ? { status: 'pending', details: { uuid: requestId, expected_head_sha: head, merge_method: 'squash', merge_action: 'default', bypass_rules: false } } : phase === 'enqueued' ? { status: 'enqueued', details: {} } : { status: 'merged', details: { sha: mergedCommit } });
      return Response.json({ number: 1, state: phase === 'merged' ? 'closed' : 'open', merged: phase === 'merged', merge_commit_sha: phase === 'merged' ? mergedCommit : null, head: { sha: head, ref: 'embermend/fixture' }, base: { ref: 'main', sha: base } });
    };
    const service = new Embermend(db, magnus, new GitHubClient('fixture-token-not-real', [{ providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', allowedBranches: ['main'], workflowIds: [] }], fake));
    await records.entity(operator, { id: 'fixture-repository', kind: 'repository', scope, label: 'Fixture repository', provenance: { source: 'github', assurance: 'established', evidenceIds: [], observedAt: now() }, provider: 'github', providerInstance: 'https://github.com', providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', environment: 'lab', accessRevision: 1 });
    await records.evidence(operator, { ...evidence(), id: 'source-proof', subjectId: 'fixture-repository' });
    await records.finding(operator, { ...finding(), id: 'source-finding', identity: 'c'.repeat(64), kind: 'code', component: 'fixture-app', weakness: 'injection', evidenceIds: ['source-proof'] }, { ...occurrence(), id: 'source-occurrence', findingId: 'source-finding', subjectId: 'fixture-repository', branch: 'main', revision: base, sourceState: 'open', runtimeState: 'unknown', evidenceIds: ['source-proof'] });
    const edits = [{ path: 'apps/api/index.ts', beforeDigest: 'a'.repeat(64), content: 'fixture repaired source' }]; const patchDigest = digest(edits);
    const preparation = { id: 'fixture-prepared-change', repositoryId: 'fixture-repository', applicationId: 'fixture-app', providerId: '123', scope, baseCommit: base, branch: 'main', workerTargetId: 'fixture-node', includedPaths: ['apps/api'], excludedPaths: [], edits, validationProfileId: 'fixture-validation', deadline: later() };
    const prepared = { preparationId: preparation.id, baseCommit: base, patchDigest, validated: true, edits, validationEvidence: { method: 'fixture-test' }, coverage: { status: 'complete', requested: ['apps/api/index.ts'], examined: ['apps/api/index.ts'], excluded: [], failures: [], mode: 'incremental', observedAt: now() } };
    await db.preparation.create({ data: { id: preparation.id, installationId: scope.installationId, repositoryId: preparation.repositoryId, applicationId: preparation.applicationId, jobId: 'fixture-preparation-job', requestDigest: digest(preparation), data: preparation, result: prepared } });
    const value: Plan = { ...plan(), id: 'fixture-merge-plan', campaignId: 'fixture-merge-campaign', findingIds: ['source-finding'], evidenceIds: ['source-proof'], canaryTargetId: 'fixture-repository', actions: [{ ...plan().actions[0], id: 'merge-fix', version: 'repository-merge.v1', class: 'merge', targetId: 'fixture-repository', targetKind: 'repository', requiredCapabilities: ['embermend:repository-merge.v1'], parameters: { changeId: preparation.id, headCommit: head, checksDigest: digest(checks) }, preconditions: { environment: 'lab', branch: 'main' }, dependsOn: [], verificationIds: ['merged-source-check'], recovery: 'Separate source recovery approval required', expectedRevision: base, patchDigest, disruption: 'none' }] };
    await db.repositoryChange.create({ data: { id: preparation.id, installationId: scope.installationId, planId: value.id, revision: 1, repositoryId: preparation.repositoryId, baseCommit: base, patchDigest, state: 'pull-request', providerIdentity: '1', data: { number: 1, url: 'https://github.com/fixture-owner/fixture-repository/pull/1', headCommit: head } } });
    const proposed = await service.propose(operator, value); await service.publish(operator, value.id, 1); await service.decide(operator, { planId: value.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: value.expiresAt });
    const accepted = await service.dispatch(operator, value.id, 'merge-fix'); assert.equal(accepted.state, 'queued'); assert.equal(accepted.ownershipReleased, false); assert.equal(writes, 1);
    assert.equal((await db.repositoryChange.findUniqueOrThrow({ where: { id: preparation.id } })).state, 'pull-request');
    assert.equal((await service.reconcile(operator, accepted.operationId)).state, 'queued'); phase = 'enqueued'; const queued = await service.reconcile(operator, accepted.operationId); assert.equal(queued.state, 'queued'); assert.equal(queued.ownershipReleased, false);
    phase = 'merged'; const finished = await service.reconcile(operator, accepted.operationId); assert.equal(finished.state, 'completed'); assert.equal(finished.result['commit'], mergedCommit); assert.equal(finished.ownershipReleased, true);
    assert.deepEqual(await service.reconcile(operator, accepted.operationId), finished); assert.equal(writes, 1);
    const retained = await db.repositoryChange.findUniqueOrThrow({ where: { id: preparation.id } }); assert.equal(retained.state, 'merged'); assert.equal(typeof retained.data === 'object' && retained.data !== null && !Array.isArray(retained.data) ? retained.data['url'] : null, 'https://github.com/fixture-owner/fixture-repository/pull/1');
  });

});
