import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { database, digest, claim, enqueue, json } from '@hivemagnus/embermend-store';
import { Embermend } from '@hivemagnus/embermend-core';
import { IntegrationError, GitHubClient, type Magnus, type ArtifactPublisher } from '@hivemagnus/embermend-integrations';
import { buildSchema, receiptSchema, scanRequestSchema, type OperationRequest, type Receipt, type Plan, type Actor } from '@hivemagnus/embermend-contracts';
import { operator, coordinator, target, finding, occurrence, evidence, plan, policy, now, later, scope } from '../fixtures.js';
import { tick } from '../../services/runtime/dist/worker.js';
import { AssessmentLedger } from '../../services/runtime/dist/assessment-ledger.js';
import { reconcileDeploymentInventory } from '../../services/runtime/dist/deployment-inventory.js';
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
  await t.test('operator review can outlive cached heartbeat but fresh Magnus identity and eligibility remain required', async () => {
    const { service, magnus } = await reset();
    const original = target(); assert.equal(original.kind, 'target'); if (original.kind !== 'target') throw new Error('Fixture target required');
    await service.entity(operator, { ...original, lifecycle: 'offline', lastSeenAt: new Date(Date.now() - 600000).toISOString() });
    const proposed = await service.propose(coordinator, plan()); await service.publish(coordinator, proposed.id, 1);
    await service.decide(operator, { planId: proposed.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: (await service.plan(operator, proposed.id)).expiresAt });
    const fresh = await magnus.capabilities();
    for (const changed of [{ agentId: 'replacement-agent' }, { executionNamespace: 'replacement-namespace' }, { environment: 'production' }, { instanceId: 'replacement-instance' }, { scope: { ...scope, targetIds: ['another-target'] } }]) {
      magnus.capabilities = async () => ({ ...fresh, targets: [{ ...original, ...changed }] });
      await assert.rejects(service.dispatch(coordinator, proposed.id, 'fixture-action'), /TARGET_EXECUTION_IDENTITY_CHANGED/);
    }
    for (const changed of [{ lifecycle: 'offline' as const }, { lastSeenAt: new Date(0).toISOString() }, { capabilities: [] }]) {
      magnus.capabilities = async () => ({ ...fresh, targets: [{ ...original, ...changed }] });
      await assert.rejects(service.dispatch(coordinator, proposed.id, 'fixture-action'), /TARGET_(NOT_ELIGIBLE|CAPABILITY_UNAVAILABLE)/);
    }
    magnus.capabilities = async () => ({ ...fresh, observedAt: new Date(0).toISOString() });
    await assert.rejects(service.dispatch(coordinator, proposed.id, 'fixture-action'), /MAGNUS_CAPABILITIES_STALE/);
    assert.equal(magnus.requests.length, 0);
    magnus.capabilities = async () => fresh;
    await service.dispatch(coordinator, proposed.id, 'fixture-action'); assert.equal(magnus.requests.length, 1);
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
  await t.test('an older concurrent native observation cannot overwrite completed ownership release', async () => {
    const { service, magnus } = await reset(); await service.propose(coordinator, plan()); await service.publish(coordinator, plan().id, 1); await service.policy(operator, policy()); await service.authorizePolicy(coordinator, plan().id, 'fixture-policy'); magnus.loseReply = true;
    await assert.rejects(service.dispatch(coordinator, plan().id, 'fixture-action'), /UNKNOWN_EXECUTION/);
    const execution = await db.execution.findFirstOrThrow(); const completed = magnus.receipts.get(execution.id); assert.ok(completed);
    let release: ((receipt: Receipt) => void) | undefined; let entered: (() => void) | undefined; const waiting = new Promise<void>(resolve => { entered = resolve; }); let count = 0;
    magnus.receipt = async () => { if (++count === 1) return new Promise<Receipt>(resolve => { release = resolve; entered?.(); }); return completed; };
    const old = service.reconcile(operator, execution.id); await waiting;
    assert.equal((await service.reconcile(operator, execution.id)).ownershipReleased, true);
    if (!release) throw new Error('Pending observation required'); release({ ...completed, state: 'running', ownershipReleased: false, result: {} });
    assert.equal((await old).state, 'completed'); const retained = await db.execution.findUniqueOrThrow({ where: { id: execution.id } }); assert.equal(retained.state, 'completed');
    magnus.receipt = async () => ({ ...completed, result: { changed: true } }); await assert.rejects(service.reconcile(operator, execution.id), /TERMINAL_RECEIPT_CONFLICT/); assert.equal(magnus.requests.length, 1);
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
  await t.test('an old native host capture in a fresh envelope cannot reopen later verification', async () => {
    const { service } = await reset(); const capturedAt = new Date(Date.now() - 30000).toISOString(); const verifiedAt = new Date(Date.now() - 10000).toISOString();
    const value = { ...finding(), id: 'timed-finding', identity: 'f'.repeat(64), evidenceIds: ['timed-baseline'] };
    const initial = { ...occurrence(), id: 'timed-occurrence', findingId: value.id, evidenceIds: ['timed-baseline'], coverage: { ...occurrence().coverage, observedAt: capturedAt } };
    await service.evidence(operator, { ...evidence(), id: 'timed-baseline', observedAt: capturedAt, content: { observedAt: capturedAt, mode: '0644' } }); await service.finding(operator, value, initial);
    const proof = { ...evidence(), id: 'timed-proof', observedAt: verifiedAt, content: { findingIdentity: value.identity, securityCheckPassed: true, runningStateVerified: true } }; await service.evidence(operator, proof);
    await service.verify(operator, { id: 'timed-verification', occurrenceId: initial.id, dimension: 'runtime', result: 'pass', method: proof.method, evidenceIds: [proof.id], coverage: { ...initial.coverage, observedAt: verifiedAt }, revision: null, artifactDigest: null, targetId: 'fixture-node', healthPassed: true, observedAt: verifiedAt, independent: true, consumerMigrationVerified: false });
    await service.evidence(operator, { ...evidence(), id: 'delayed-native-capture', observedAt: now(), content: { observedAt: capturedAt, mode: '0644' } });
    await service.finding(operator, { ...value, evidenceIds: ['delayed-native-capture'] }, { ...initial, coverage: { ...initial.coverage, observedAt: now() }, evidenceIds: ['delayed-native-capture'] });
    assert.equal(await db.occurrence.count({ where: { findingId: value.id } }), 1); assert.equal((await service.findings(operator)).find(row => row.finding.id === value.id)?.occurrences[0]?.runtimeState, 'verified-resolved');
    const history = await db.observation.findMany({ where: { source: 'finding-history', subjectId: value.id } }); assert.equal(history.length, 1); assert.equal(history[0]?.observedAt.toISOString(), capturedAt);
    await service.evidence(operator, { ...evidence(), id: 'unfamiliar-old-capture', observedAt: now(), content: { observedAt: capturedAt, mode: '0644', additionalDiagnostic: 'fixture-unrecognized-snapshot' } });
    await assert.rejects(service.finding(operator, { ...value, evidenceIds: ['unfamiliar-old-capture'] }, { ...initial, coverage: { ...initial.coverage, observedAt: now() }, evidenceIds: ['unfamiliar-old-capture'] }), /HOST_CAPTURE_ORDER_REQUIRES_REVIEW/);
    assert.equal(await db.occurrence.count({ where: { findingId: value.id } }), 1);
    const fresh = { ...evidence(), id: 'timed-fresh', observedAt: now(), content: { observedAt: now(), mode: '0644' } }; await service.evidence(operator, fresh);
    const next = { ...initial, coverage: { ...initial.coverage, observedAt: now() }, evidenceIds: [fresh.id] }; await service.finding(operator, { ...value, evidenceIds: [fresh.id] }, next); await service.finding(operator, { ...value, evidenceIds: [fresh.id] }, next);
    const occurrences = (await service.findings(operator)).find(row => row.finding.id === value.id)?.occurrences; assert.equal(occurrences?.length, 2); assert.equal(occurrences?.filter(item => item.runtimeState === 'verified-resolved').length, 1);
  });
  await t.test('finding ingestion cannot invent verified closure or change immutable occurrence identity', async () => {
    const { service } = await reset();
    for (const states of [{ sourceState: 'verified-fixed' }, { runtimeState: 'verified-resolved' }, { runtimeState: 'verified-mitigated' }]) {
      await assert.rejects(service.finding(operator, finding(), { ...occurrence(), ...states }), /VERIFICATION_OPERATION_REQUIRED/);
      await assert.rejects(service.finding(operator, finding(), { ...occurrence(), id: 'fixture-forged-closed', ...states }), /VERIFICATION_OPERATION_REQUIRED/);
    }
    for (const identity of [{ subjectId: 'another-target' }, { branch: 'another-branch' }, { revision: 'b'.repeat(40) }, { artifactDigest: 'c'.repeat(64) }]) await assert.rejects(service.finding(operator, finding(), { ...occurrence(), ...identity }), /OCCURRENCE_IDENTITY_CONFLICT/);
    assert.equal(await db.verification.count(), 0); const retained = await db.occurrence.findUniqueOrThrow({ where: { id: occurrence().id } }); assert.equal(typeof retained.data === 'object' && retained.data !== null && !Array.isArray(retained.data) ? retained.data['runtimeState'] : null, 'affected');
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
  await t.test('recommendations retain scoped job failures across restart without exposing another revision', async () => {
    const { service, magnus } = await reset(); const proposed = await service.propose(coordinator, plan());
    const broadOperator = { ...operator, scope: { ...scope, targetIds: [...scope.targetIds, 'another-target'] } };
    const id = await service.execute(broadOperator, proposed.id, { revision: proposed.revision, digest: proposed.digest });
    await db.job.update({ where: { id }, data: { status: 'unknown', error: 'TARGET_NOT_ELIGIBLE' } });
    const restarted = new Embermend(db, magnus);
    const [row] = await restarted.timeline(coordinator); assert.equal(row?.jobs[0]?.id, id); assert.equal(row?.jobs[0]?.error, 'TARGET_NOT_ELIGIBLE');
    assert.equal((await restarted.job(coordinator, id)).status, 'unknown');
    await assert.rejects(restarted.job({ ...coordinator, scope: { ...scope, targetIds: [] } }, id), /SCOPE_OR_PERMISSION_DENIED/);
    await restarted.propose(coordinator, { ...plan(), revision: 2 });
    assert.deepEqual((await restarted.timeline(coordinator))[0]?.jobs, []);
    assert.equal(await db.execution.count(), 0);
  });
  await t.test('a narrower current revision cannot expose historical execution or publication from a wider scope', async () => {
    const { service } = await reset();
    const broadScope = { ...scope, targetIds: [...scope.targetIds, 'another-target'] };
    const broadOperator = { ...operator, scope: broadScope };
    const proposed = await service.propose(broadOperator, { ...plan(), scope: broadScope });
    await service.publish(broadOperator, proposed.id, 1);
    await service.decide(broadOperator, { planId: proposed.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: (await service.plan(broadOperator, proposed.id)).expiresAt });
    const receipt = await service.dispatch(broadOperator, proposed.id, 'fixture-action');
    await service.propose(broadOperator, { ...plan(), revision: 2 });
    assert.equal((await service.plan(coordinator, proposed.id)).revision, 2);
    assert.deepEqual((await service.timeline(coordinator))[0]?.executions, []);
    const report = await service.records.campaignReport(coordinator, plan().campaignId);
    assert.deepEqual(report.plans[0]?.executions, []); assert.deepEqual(report.plans[0]?.publications, []);
    await assert.rejects(service.reconcile(coordinator, receipt.operationId), /SCOPE_OR_PERMISSION_DENIED/);
    assert.equal((await service.reconcile(broadOperator, receipt.operationId)).operationId, receipt.operationId);
    assert.equal(await db.execution.count(), 1); assert.equal(await db.publication.count(), 1);
  });
  await t.test('expired interrupted campaign observes only original operations under separate recovery authority', async () => {
    const { service, magnus } = await reset(); const proposed = await service.propose(coordinator, plan()); await service.publish(coordinator, proposed.id, 1);
    await service.decide(operator, { planId: proposed.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: (await service.plan(operator, proposed.id)).expiresAt });
    magnus.loseReply = true; const jobId = await service.execute(coordinator, proposed.id, { revision: 1, digest: proposed.digest });
    await tick(service, 'fixture-interrupted-campaign', AbortSignal.timeout(5000)); assert.equal((await service.job(operator, jobId)).status, 'unknown');
    await db.job.update({ where: { id: jobId }, data: { deadline: new Date(0), cancelRequested: true } }); await db.authorization.updateMany({ data: { expiresAt: new Date(0) } }); await service.pause(operator, plan().campaignId, true);
    const observer = { ...operator, permissions: new Set<'read' | 'evidence' | 'recover'>(['read', 'evidence', 'recover']) };
    const capabilities = magnus.capabilities; magnus.capabilities = async () => { throw new Error('Observation cannot request fresh dispatch capabilities'); };
    const observation = await service.reconcileJob(observer, jobId); await tick(service, 'fixture-campaign-observer', AbortSignal.timeout(5000));
    assert.equal((await service.job(observer, observation)).status, 'completed'); const retained = await service.job(observer, jobId); assert.equal(retained.status, 'completed'); assert.equal(retained.cancelRequested, true); assert.equal(retained.deadline, new Date(0).toISOString());
    assert.equal(magnus.requests.length, 1); assert.equal(magnus.observations, 1); magnus.capabilities = capabilities;
  });
  await t.test('cancellation after campaign claim but before native admission prevents dispatch', async () => {
    const { service, magnus } = await reset(); const proposed = await service.propose(coordinator, plan()); await service.publish(coordinator, proposed.id, 1);
    await service.decide(operator, { planId: proposed.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: (await service.plan(operator, proposed.id)).expiresAt });
    const id = await service.execute(coordinator, proposed.id, { revision: 1, digest: proposed.digest }); const capabilities = magnus.capabilities.bind(magnus);
    magnus.capabilities = async () => { await service.cancelJob(operator, id); return capabilities(); };
    await tick(service, 'fixture-cancel-before-native', AbortSignal.timeout(5000));
    assert.equal((await service.job(operator, id)).cancelRequested, true); assert.equal(magnus.requests.length, 0); assert.equal(await db.execution.count(), 0);
  });
  await t.test('native campaign admission rechecks deadline, lease owner and exact job binding', async () => {
    for (const mode of ['deadline', 'lease', 'owner', 'binding']) {
      const { service, magnus } = await reset(); const value = plan(); const proposed = await service.propose(coordinator, value); await service.publish(coordinator, proposed.id, 1);
      await service.decide(operator, { planId: proposed.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: value.expiresAt });
      const id = await service.execute(coordinator, proposed.id, { revision: 1, digest: proposed.digest }); const capabilities = magnus.capabilities.bind(magnus);
      magnus.capabilities = async () => { await db.job.update({ where: { id }, data: mode === 'deadline' ? { deadline: new Date(0) } : mode === 'lease' ? { leaseUntil: new Date(0) } : mode === 'owner' ? { leaseOwner: 'another-worker' } : { payload: { planId: 'another-plan', revision: 1, scope } } }); return capabilities(); };
      await tick(service, 'fixture-displaced-worker', AbortSignal.timeout(5000)); assert.equal(magnus.requests.length, 0, mode); assert.equal(await db.execution.count(), 0, mode);
    }
  });
  await t.test('campaign observation never starts an action that has no original reservation', async () => {
    const { service, magnus } = await reset(); const proposed = await service.propose(coordinator, plan()); const id = await service.execute(coordinator, proposed.id, { revision: 1, digest: proposed.digest });
    await db.job.update({ where: { id }, data: { status: 'unknown' } }); const observed = await service.reconcileJob(operator, id); await tick(service, 'fixture-observer-no-dispatch', AbortSignal.timeout(5000));
    assert.equal((await service.job(operator, observed)).error, 'CAMPAIGN_ACTION_NOT_DISPATCHED_OBSERVATION_ONLY'); assert.equal((await service.job(operator, id)).status, 'unknown'); assert.equal(magnus.requests.length, 0);
  });
  await t.test('artifact rollout requires exact deployment, immutable source and independently retained build provenance', async () => {
    const { service, magnus } = await reset(); const current = target(); assert.equal(current.kind, 'target'); if (current.kind !== 'target') throw new Error('Target required');
    magnus.capabilities = async () => ({ protocol: 1, installationId: 'fixture-magnus', serviceVersion: 'fixture', actions: ['file-mode.v1', 'inventory.v1', 'compose-deploy.v1'], targets: [{ ...current, capabilities: [...current.capabilities, 'embermend:compose-deploy.v1'] }], observedAt: now() });
    const actor = { ...coordinator, permissions: new Set([...coordinator.permissions, 'deploy' as const]) }; const value = plan(); const original = value.actions[0]; assert.ok(original);
    const deployPlan = { ...value, actions: [{ ...original, version: 'compose-deploy.v1', class: 'deploy' as const, requiredCapabilities: ['embermend:compose-deploy.v1'], parameters: { deploymentId: 'fixture-deployment', artifactDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), beforeDigest: 'c'.repeat(64) }, disruption: 'outage' as const }] };
    const proposed = await service.propose(actor, deployPlan); await service.publish(actor, proposed.id, 1); await service.decide(operator, { planId: proposed.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: deployPlan.expiresAt });
    await assert.rejects(service.dispatch(actor, proposed.id, original.id), /DEPLOYMENT_BINDING/);
    const base = { scope, label: 'Fixture', provenance: { source: 'fixture-review', assurance: 'established', evidenceIds: [], observedAt: now() } };
    await service.entity(operator, { ...base, id: 'fixture-product-deployment', kind: 'deployment', magnusResourceId: 'fixture-deployment', applicationId: 'fixture-app', environment: 'lab', artifactIds: [], targetIds: ['fixture-node'], configurationDigest: 'b'.repeat(64) });
    await assert.rejects(service.dispatch(actor, proposed.id, original.id), /ARTIFACT_PROVENANCE/);
    const artifact = { ...base, id: 'fixture-artifact', kind: 'artifact', digest: 'a'.repeat(64), sourceRevisionIds: ['fixture-source'], buildRunId: null, image: 'registry.example.com/fixture/app@sha256:' + 'a'.repeat(64) };
    await service.entity(operator, artifact); await assert.rejects(service.dispatch(actor, proposed.id, original.id), /SOURCE_REVISION/);
    const source = { ...base, id: 'fixture-source', kind: 'source-revision', repositoryId: 'fixture-repository', commit: 'd'.repeat(40), branch: 'main' };
    await service.entity(operator, source); await assert.rejects(service.dispatch(actor, proposed.id, original.id), /BUILD_EVIDENCE/);
    await service.evidence(operator, { ...evidence(), id: 'fixture-build-proof', subjectId: artifact.id, source: 'independent-build-review', content: { artifactDigest: artifact.digest, imageRef: artifact.image, sourceCommit: source.commit, buildVerified: true } });
    await service.entity(operator, { ...artifact, provenance: { ...base.provenance, evidenceIds: ['fixture-build-proof'] } });
    await assert.rejects(service.entity(operator, { ...source, commit: 'e'.repeat(40) }), /IMMUTABLE_ARTIFACT_OR_SOURCE_IDENTITY/);
    await assert.rejects(service.entity(operator, { ...artifact, sourceRevisionIds: ['replacement-source'] }), /IMMUTABLE_ARTIFACT_OR_SOURCE_IDENTITY/);
    const otherScope = { ...scope, targetIds: ['fixture-other'] }; const broad = { ...operator, scope: { ...scope, targetIds: ['fixture-node', 'fixture-other'] } };
    await service.entity(broad, { ...base, scope: otherScope, id: 'fixture-other-deployment', kind: 'deployment', magnusResourceId: 'fixture-deployment', applicationId: 'fixture-app', environment: 'lab', artifactIds: [], targetIds: ['fixture-other'], configurationDigest: 'b'.repeat(64) });
    assert.equal(magnus.requests.length, 0); await service.dispatch(actor, proposed.id, original.id); assert.equal(magnus.requests.length, 1);
    await service.entity(operator, { ...base, id: 'fixture-ambiguous-deployment', kind: 'deployment', magnusResourceId: 'fixture-deployment', applicationId: 'fixture-app', environment: 'lab', artifactIds: [], targetIds: ['fixture-node'], configurationDigest: 'b'.repeat(64) });
    const next = { ...deployPlan, id: 'ambiguous-deploy-plan', campaignId: 'ambiguous-deploy-campaign' }; const admitted = await service.propose(actor, next); await service.publish(actor, next.id, 1); await service.decide(operator, { planId: next.id, revision: 1, digest: admitted.digest, decision: 'approve', expiresAt: next.expiresAt });
    await assert.rejects(service.dispatch(actor, next.id, original.id), /DEPLOYMENT_BINDING/); assert.equal(magnus.requests.length, 1);
  });
  await t.test('independent Compose inventory preserves replaced instances and unknown coverage without closing security work', async () => {
    const { service } = await reset(); const observedAt = new Date(Date.now() - 5000).toISOString(); const provenance = { source: 'fixture', assurance: 'established', evidenceIds: [], observedAt };
    const base = { scope, label: 'Fixture', provenance };
    await service.entity(operator, { ...base, id: 'fixture-agent', kind: 'management-agent', magnusInstallationId: 'fixture-magnus', magnusAgentId: 'fixture-native-agent', targetIds: ['fixture-node'], capabilities: [], version: 'fixture', lifecycle: 'active' });
    const image = (value: string) => 'registry.example.com/fixture/app@sha256:' + value.repeat(64);
    for (const value of ['a', 'd']) await service.entity(operator, { ...base, id: 'fixture-artifact-' + value, kind: 'artifact', digest: value.repeat(64), image: image(value), sourceRevisionIds: [], buildRunId: null });
    await service.entity(operator, { ...base, id: 'fixture-product-deployment', kind: 'deployment', magnusResourceId: 'fixture-deployment', applicationId: 'fixture-app', environment: 'lab', artifactIds: ['fixture-artifact-a'], targetIds: ['fixture-node'], configurationDigest: 'b'.repeat(64) });
    const inventory = async (id: string, value: string, timestamp: string, configurationDigest = 'b'.repeat(64)) => {
      await service.evidence(operator, { ...evidence(), id, observedAt: timestamp, source: 'magnus', content: { resources: { 'fixture-deployment': { configurationDigest, beforeDigest: 'c'.repeat(64), observedAt: timestamp, instances: [{ id: value.repeat(64), imageId: 'sha256:' + 'e'.repeat(64), imageRef: image(value), status: 'running', running: true, health: 'healthy', startedAt: timestamp, service: 'web', project: 'fixture' }] } } } });
      return service.readEvidence(operator, id);
    };
    const first = await inventory('fixture-before', 'a', now()); await reconcileDeploymentInventory(service, operator, first); await reconcileDeploymentInventory(service, operator, first);
    assert.equal(await db.entity.count({ where: { kind: 'container-instance' } }), 1); assert.equal(await db.relationship.count(), 4);
    const after = await inventory('fixture-after', 'd', new Date(Date.now() + 1000).toISOString()); await reconcileDeploymentInventory(service, operator, after);
    assert.equal(await db.entity.count({ where: { kind: 'container-instance' } }), 2); await reconcileDeploymentInventory(service, operator, first);
    const deployment = (await service.entities(operator)).find(row => row.id === 'fixture-product-deployment'); assert.equal(deployment?.kind, 'deployment'); if (deployment?.kind === 'deployment') assert.deepEqual(deployment.artifactIds, ['fixture-artifact-d']);
    await service.evidence(operator, { ...first, id: 'fixture-delayed-old', observedAt: new Date(Date.now() + 3000).toISOString() });
    await reconcileDeploymentInventory(service, operator, await service.readEvidence(operator, 'fixture-delayed-old'));
    const delayed = (await service.entities(operator)).find(row => row.id === 'fixture-product-deployment'); if (delayed?.kind === 'deployment') assert.deepEqual(delayed.artifactIds, ['fixture-artifact-d']);
    const links = await service.records.relationships(operator); assert.equal(links.length, 8); assert.ok(links.some(link => link.provenance.evidenceIds.includes('fixture-before'))); assert.ok(links.every(link => !link.provenance.evidenceIds.includes('fixture-delayed-old')));
    assert.equal(await db.observation.count({ where: { source: 'relationship-evidence' } }), 4);
    const unknown = await inventory('fixture-unknown', 'f', new Date(Date.now() + 2000).toISOString()); assert.match(JSON.stringify(await reconcileDeploymentInventory(service, operator, unknown)), /partial/);
    const changed = await inventory('fixture-config-changed', 'd', now(), 'f'.repeat(64)); assert.match(JSON.stringify(await reconcileDeploymentInventory(service, operator, changed)), /not-assessed/);
    await service.evidence(operator, { ...evidence(), id: 'fixture-no-resource', content: {} }); assert.match(JSON.stringify(await reconcileDeploymentInventory(service, operator, await service.readEvidence(operator, 'fixture-no-resource'))), /not-assessed/);
    assert.equal(await db.entity.count({ where: { kind: 'container-instance' } }), 2); assert.equal((await service.findings(operator))[0]?.occurrences[0]?.runtimeState, 'affected');
  });
  await t.test('globally visible endpoints do not reveal or permit adoption of an out-of-scope relationship', async () => {
    const { service } = await reset(); const global = { installationId: scope.installationId, applicationIds: [], targetIds: [] };
    const otherScope = { ...scope, targetIds: ['fixture-other'] }; const broad = { ...operator, scope: { ...scope, targetIds: ['fixture-node', 'fixture-other'] } };
    for (const [id, marker] of [['global-a', 'a'], ['global-b', 'b']]) {
      if (!id || !marker) throw new Error('Fixture identity required');
      await service.entity(broad, { id, kind: 'artifact', scope: global, label: id, provenance: { source: 'fixture', assurance: 'unknown', evidenceIds: [], observedAt: now() }, digest: marker.repeat(64), sourceRevisionIds: [], buildRunId: null, image: null });
    }
    await service.evidence(broad, { ...evidence(), id: 'private-edge-proof', scope: otherScope, subjectId: 'global-a' });
    const edge = { id: 'private-edge', scope: otherScope, fromId: 'global-a', toId: 'global-b', kind: 'built-from', provenance: { source: 'fixture', assurance: 'established', evidenceIds: ['private-edge-proof'], observedAt: now() } };
    await service.records.relationship(broad, edge); assert.equal((await service.records.relationships(broad)).length, 1); assert.deepEqual(await service.records.relationships(coordinator), []);
    await assert.rejects(service.records.relationship(operator, { ...edge, id: 'guessed-edge', scope, provenance: { ...edge.provenance, evidenceIds: [evidence().id] } }), /SCOPE_OR_PERMISSION_DENIED/);
    assert.equal(await db.relationship.count(), 1);
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
  await t.test('post-ingestion result commit failure reuses the retained terminal inventory without rewriting evidence', async child => {
    const { service, magnus } = await reset();
    await service.profile(operator, { id: 'fixture-result-cut', version: '1', platform: 'ubuntu-24.04', rules: [{ id: 'fixture-rule', explanation: 'Retain the original inventory evidence', capability: 'inventory.v1', field: 'exitCode', expected: 1, actionVersion: null }] });
    const id = await service.assess(operator, { id: 'fixture-result-cut', scope, targetIds: ['fixture-node'], profileId: 'fixture-result-cut', profileVersion: '1', deadline: later() });
    const cut = child.mock.method(AssessmentLedger.prototype, 'result', async () => { throw new Error('Fixture interruption after evidence ingestion'); });
    await tick(service, 'fixture-result-cut-worker', AbortSignal.timeout(5000)); cut.mock.restore();
    const interrupted = await service.job(operator, id); assert.equal(interrupted.status, 'unknown');
    const before = await db.evidence.findMany({ where: { subjectId: 'fixture-node' }, orderBy: { id: 'asc' } }); assert.equal(before.length, 2);
    const receipt = [...magnus.receipts.values()][0]; assert.ok(receipt);
    // A later receipt envelope is not a new observation of the managed resource.
    magnus.receipt = async () => { magnus.observations++; return { ...receipt, observedAt: new Date(Date.parse(receipt.observedAt) + 10000).toISOString() }; };
    magnus.capabilitiesAvailable = false;
    const observationId = await service.reconcileJob(operator, id); await tick(service, 'fixture-result-cut-observer', AbortSignal.timeout(5000));
    const observed = await service.job(operator, observationId); assert.equal(observed.status, 'completed', observed.error ?? undefined);
    assert.equal((await service.job(operator, id)).status, 'completed'); assert.equal(magnus.requests.length, 1);
    assert.equal(magnus.observations, 0); assert.deepEqual(await db.evidence.findMany({ where: { subjectId: 'fixture-node' }, orderBy: { id: 'asc' } }), before);
  });
  for (const changedContent of [false, true]) await t.test(`an interrupted older observer preserves original inventory evidence with changed content ${changedContent}`, async child => {
    const { service, magnus } = await reset();
    await service.profile(operator, { id: 'fixture-legacy-result', version: '1', platform: 'ubuntu-24.04', rules: [{ id: 'fixture-rule', explanation: 'Preserve original evidence', capability: 'inventory.v1', field: 'exitCode', expected: 1, actionVersion: null }] });
    const id = await service.assess(operator, { id: 'fixture-legacy-result', scope, targetIds: ['fixture-node'], profileId: 'fixture-legacy-result', profileVersion: '1', deadline: later() });
    const cut = child.mock.method(AssessmentLedger.prototype, 'result', async () => { throw new Error('Fixture interruption after ingestion'); });
    await tick(service, 'fixture-legacy-result-worker', AbortSignal.timeout(5000)); cut.mock.restore();
    const retained = z.object({ operations: z.array(z.object({ receipt: receiptSchema }).passthrough()) }).parse((await service.job(operator, id)).result);
    const entry = retained.operations[0]; assert.ok(entry);
    entry.receipt = { ...entry.receipt, observedAt: new Date(Date.parse(entry.receipt.observedAt) + 10000).toISOString(), ...(changedContent ? { result: { exitCode: 2 } } : {}) };
    await db.job.update({ where: { id }, data: { result: json(retained) } });
    const before = await db.evidence.findMany({ orderBy: { id: 'asc' } });
    const observationId = await service.reconcileJob(operator, id); await tick(service, 'fixture-legacy-result-observer', AbortSignal.timeout(5000));
    const observed = await service.job(operator, observationId);
    assert.equal(observed.status, changedContent ? 'unknown' : 'completed', observed.error ?? undefined);
    if (changedContent) assert.equal(observed.error, 'IMMUTABLE_EVIDENCE_CONFLICT');
    assert.equal((await service.job(operator, id)).status, changedContent ? 'unknown' : 'completed');
    assert.equal(magnus.requests.length, 1); assert.equal(magnus.observations, 0);
    assert.deepEqual(await db.evidence.findMany({ orderBy: { id: 'asc' } }), before);
  });
  await t.test('cached terminal assessment receipts still require the exact retained request binding', async child => {
    const { service, magnus } = await reset();
    await service.profile(operator, { id: 'fixture-cached-binding', version: '1', platform: 'ubuntu-24.04', rules: [{ id: 'fixture-rule', explanation: 'Bind original evidence', capability: 'inventory.v1', field: 'exitCode', expected: 1, actionVersion: null }] });
    const id = await service.assess(operator, { id: 'fixture-cached-binding', scope, targetIds: ['fixture-node'], profileId: 'fixture-cached-binding', profileVersion: '1', deadline: later() });
    const cut = child.mock.method(AssessmentLedger.prototype, 'result', async () => { throw new Error('Fixture result checkpoint interrupted'); });
    await tick(service, 'fixture-binding-cut-worker', AbortSignal.timeout(5000)); cut.mock.restore();
    const retained = z.object({ operations: z.array(z.object({ receipt: receiptSchema }).passthrough()) }).parse((await service.job(operator, id)).result);
    const entry = retained.operations[0]; assert.ok(entry); entry.receipt = { ...entry.receipt, requestDigest: 'f'.repeat(64) };
    await db.job.update({ where: { id }, data: { result: json(retained) } });
    const before = await db.evidence.findMany({ orderBy: { id: 'asc' } });
    const observationId = await service.reconcileJob(operator, id); await tick(service, 'fixture-cached-binding-observer', AbortSignal.timeout(5000));
    assert.equal((await service.job(operator, observationId)).error, 'ASSESSMENT_RECEIPT_BINDING');
    assert.equal((await service.job(operator, id)).status, 'unknown'); assert.equal(magnus.requests.length, 1); assert.equal(magnus.observations, 0);
    assert.deepEqual(await db.evidence.findMany({ orderBy: { id: 'asc' } }), before);
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

  const publicationFixture = async () => {
    const { service: records, magnus } = await reset(); const base = 'a'.repeat(40); const artifactDigest = 'd'.repeat(64); const appScope = { ...scope, targetIds: [] }; let head = base; let writes = 0; let published = false; let loseReply = false;
    const expected = { artifactId: 'fixture-published-artifact', artifactDigest, sourceCommits: [base], reviewEvidenceId: 'fixture-publication-review', archiveDigest: 'b'.repeat(64), destinationId: 'fixture-registry', imageRef: 'registry.example.com/fixture/catalog@sha256:' + artifactDigest };
    const publisher: ArtifactPublisher = { describe: (id, hash, destination) => { if (id !== expected.artifactId || hash !== expected.artifactDigest || destination !== expected.destinationId) throw new Error('CATALOG_ENTRY_REQUIRED'); return expected; }, validate: async value => { assert.deepEqual(value, expected); }, publish: async value => { assert.deepEqual(value, expected); writes++; published = true; if (loseReply) throw new Error('Fixture lost publication reply'); return { ...expected, providerOperationId: expected.imageRef }; }, observe: async value => { assert.deepEqual(value, expected); return published ? { ...expected, providerOperationId: expected.imageRef } : null; } };
    const request: typeof fetch = async url => Response.json(new URL(String(url)).pathname.startsWith('/repositories/') ? { id: 123, owner: { login: 'fixture-owner' }, name: 'fixture-repository', full_name: 'fixture-owner/fixture-repository', default_branch: 'main' } : { sha: head, commit: { tree: { sha: base } } });
    const github = new GitHubClient('fixture-read-token', [{ providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', allowedBranches: ['main'], workflowIds: ['7'] }], request); const service = new Embermend(db, magnus, github, publisher);
    const provenance = { source: 'fixture-review', assurance: 'established', evidenceIds: [], observedAt: now() };
    await records.entity(operator, { id: 'fixture-repository', kind: 'repository', scope: { ...appScope, applicationIds: [] }, label: 'Fixture repository', provenance, provider: 'github', providerInstance: 'https://github.com', providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', environment: 'lab', accessRevision: 1 });
    await records.entity(operator, { id: 'fixture-source-binding', kind: 'source-binding', scope: appScope, label: 'Fixture application', provenance, repositoryId: 'fixture-repository', applicationId: 'fixture-app', includedPaths: ['apps/api'], excludedPaths: [], maintainedBranches: ['main'], buildDefinitions: ['.github/workflows/build.yml'], modelPolicy: { providerRefs: [], allowRemote: false, allowExecution: false } });
    await records.entity(operator, { id: 'fixture-source', kind: 'source-revision', scope: appScope, label: 'Fixture source', provenance, repositoryId: 'fixture-repository', commit: base, branch: 'main' });
    const proof = { ...evidence(), id: expected.reviewEvidenceId, scope: appScope, subjectId: expected.artifactId, source: 'independent-build-review', content: { archiveDigest: expected.archiveDigest, artifactDigest, imageRef: expected.imageRef, sourceCommit: base, buildVerified: true, attestationVerified: true, providerRunId: 42, runAttempt: 1 } }; await records.evidence(operator, proof);
    const build = buildSchema.parse({ id: 'fixture-build', scope: appScope, repositoryId: 'fixture-repository', applicationId: 'fixture-app', sourceRevisionId: 'fixture-source', sourceCommit: base, providerRunId: 42, runAttempt: 1, workflowId: 7, workflowPath: '.github/workflows/build.yml', status: 'completed', conclusion: 'success', providerUpdatedAt: now(), observedAt: now(), providerUrl: 'https://github.com/fixture-owner/fixture-repository/actions/runs/42', evidenceIds: [proof.id], artifactProvenance: 'unestablished' });
    await db.build.create({ data: { id: build.id, installationId: scope.installationId, repositoryId: build.repositoryId, sourceCommit: base, providerRunId: '42', providerAttempt: 1, status: build.status, data: json(build) } });
    await records.entity(operator, { id: expected.artifactId, kind: 'artifact', scope: appScope, label: 'Reviewed fixture image', provenance: { ...provenance, evidenceIds: [proof.id] }, digest: artifactDigest, sourceRevisionIds: ['fixture-source'], buildRunId: build.id, image: expected.imageRef });
    const value = plan(); const previous = value.actions[0]; assert.ok(previous);
    const proposedPlan = { ...value, evidenceIds: [proof.id], canaryTargetId: 'fixture-repository', actions: [{ ...previous, version: 'artifact-publish.v1', class: 'artifact-publish' as const, targetId: 'fixture-repository', targetKind: 'repository' as const, requiredCapabilities: ['embermend:artifact-publish.v1'], parameters: { artifactId: expected.artifactId, digest: artifactDigest, destinationId: expected.destinationId }, preconditions: { environment: 'lab', branch: 'main' }, expectedRevision: base, patchDigest: null }] };
    const proposed = await service.propose(coordinator, proposedPlan); const writer = { ...coordinator, permissions: new Set([...coordinator.permissions, 'artifact-publish' as const]) };
    return { service, magnus, expected, proposedPlan, proposed, writer, publishExplanation: () => service.publish(coordinator, proposedPlan.id, 1), approve: () => service.decide(operator, { planId: proposedPlan.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: proposedPlan.expiresAt }), writes: () => writes, loseReply: () => { loseReply = true; }, changeHead: () => { head = 'c'.repeat(40); } };
  };
  await t.test('publication needs its own permission, explanation, exact approval, successful build and reviewed attestation', async () => {
    const f = await publicationFixture(); await assert.rejects(f.service.dispatch(coordinator, f.proposedPlan.id, 'fixture-action'), /PERMISSION/); await assert.rejects(f.service.dispatch(f.writer, f.proposedPlan.id, 'fixture-action'), /PUBLICATION/);
    await f.publishExplanation(); await assert.rejects(f.service.dispatch(f.writer, f.proposedPlan.id, 'fixture-action'), /AUTHORIZATION/); await f.approve();
    const result = await f.service.dispatch(f.writer, f.proposedPlan.id, 'fixture-action'); assert.equal(result.state, 'completed'); assert.equal(result.result['providerOperationId'], f.expected.imageRef); assert.equal(f.writes(), 1);
    assert.deepEqual(await f.service.dispatch(f.writer, f.proposedPlan.id, 'fixture-action'), result); assert.equal(f.writes(), 1); assert.equal(f.magnus.requests.length, 0);
  });
  await t.test('lost publication replies preserve one external effect and reconcile after revocation using reads', async () => {
    const f = await publicationFixture(); await f.publishExplanation(); await f.approve(); f.loseReply(); await assert.rejects(f.service.dispatch(f.writer, f.proposedPlan.id, 'fixture-action'), /lost publication/); assert.equal(f.writes(), 1);
    const execution = await db.execution.findFirstOrThrow(); assert.equal(execution.state, 'unknown'); await db.authorization.updateMany({ data: { revoked: true, expiresAt: new Date(0) } });
    const receipt = await f.service.reconcile(operator, execution.id); assert.equal(receipt.state, 'completed'); assert.equal(receipt.ownershipReleased, true); assert.equal(f.writes(), 1); assert.equal((await db.providerEffect.findFirstOrThrow()).state, 'completed'); assert.deepEqual(await f.service.reconcile(operator, execution.id), receipt);
    assert.equal((await f.service.findings(operator))[0]?.occurrences[0]?.runtimeState, 'affected'); assert.equal(f.magnus.requests.length, 0);
  });
  await t.test('publication rechecks current source head, policy and immutable review before any external write', async () => {
    for (const change of ['head', 'policy', 'review', 'build']) {
      const f = await publicationFixture(); await f.publishExplanation(); await f.approve();
      if (change === 'head') f.changeHead();
      if (change === 'policy') { const row = await db.entity.findUniqueOrThrow({ where: { id: 'fixture-source-binding' } }); const value = z.object({ maintainedBranches: z.array(z.string()) }).passthrough().parse(row.data); await db.entity.update({ where: { id: row.id }, data: { data: json({ ...value, maintainedBranches: [] }) } }); }
      if (change === 'review') { const row = await db.entity.findUniqueOrThrow({ where: { id: f.expected.artifactId } }); const value = z.object({ provenance: z.object({ evidenceIds: z.array(z.string()) }).passthrough() }).passthrough().parse(row.data); await db.entity.update({ where: { id: row.id }, data: { data: json({ ...value, provenance: { ...value.provenance, evidenceIds: [] } }) } }); }
      if (change === 'build') { const row = await db.build.findUniqueOrThrow({ where: { id: 'fixture-build' } }); const build = buildSchema.parse(row.data); await db.build.update({ where: { id: row.id }, data: { data: json({ ...build, conclusion: 'failure' }) } }); }
      await assert.rejects(f.service.dispatch(f.writer, f.proposedPlan.id, 'fixture-action'), /PUBLICATION_(SOURCE_HEAD_CHANGED|SOURCE_POLICY_CHANGED|ARTIFACT_REQUIRED|BUILD_REQUIRED)/); assert.equal(f.writes(), 0); assert.equal(await db.providerEffect.count(), 0);
    }
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

  await t.test('durable build observations retain attempts, scope and immutable workflow evidence without provider writes', async () => {
    const { service: records, magnus } = await reset();
    const base = { scope, label: 'Fixture', provenance: { source: 'fixture', assurance: 'established', evidenceIds: [], observedAt: now() } };
    await records.entity(operator, { ...base, id: 'build-repo', kind: 'repository', provider: 'github', providerInstance: 'https://github.com', providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', accessRevision: 1 });
    const binding = { ...base, id: 'build-binding', kind: 'source-binding', repositoryId: 'build-repo', applicationId: 'fixture-app', includedPaths: ['apps/api'], excludedPaths: [], maintainedBranches: ['main'], buildDefinitions: ['.github/workflows/build.yml'] };
    await records.entity(operator, binding);
    await records.entity(operator, { ...base, id: 'build-source', kind: 'source-revision', repositoryId: 'build-repo', commit: 'a'.repeat(40), branch: 'main' });
    let status = 'in_progress'; let conclusion: string | null = null; let attempt = 1; let updatedAt = new Date(Date.now() - 10000).toISOString(); let cancelId: string | null = null; let outage = false; let duringRead: (() => Promise<void>) | undefined;
    const methods: string[] = [];
    const request: typeof fetch = async (url, init) => {
      methods.push(init?.method ?? 'GET');
      if (new URL(String(url)).pathname.startsWith('/repositories/')) return Response.json({ id: 123, full_name: 'fixture-owner/fixture-repository', owner: { login: 'fixture-owner' }, name: 'fixture-repository', default_branch: 'main' });
      if (outage) throw new Error('Fixture outage');
      if (cancelId) await records.cancelJob(operator, cancelId); if (duringRead) await duringRead();
      return Response.json({ id: 42, run_attempt: attempt, workflow_id: 7, path: '.github/workflows/build.yml', head_sha: 'a'.repeat(40), head_branch: 'main', status, conclusion, html_url: 'https://github.com/fixture-owner/fixture-repository/actions/runs/42', updated_at: updatedAt, repository: { id: 123 }, head_repository: { id: 123 } });
    };
    const service = new Embermend(db, magnus, new GitHubClient('fixture-read-token', [{ providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', allowedBranches: ['main'], workflowIds: ['7'] }], request));
    const input = { id: 'build-first', scope, repositoryId: 'build-repo', applicationId: 'fixture-app', sourceRevisionId: 'build-source', providerRunId: 42, runAttempt: 1, workflowId: 7, workflowPath: '.github/workflows/build.yml', deadline: later() };
    const worker = async () => { await tick(service, 'build-worker', AbortSignal.timeout(30000)); };
    const jobId = await service.builds.request(operator, input); assert.equal(await service.builds.request(operator, input), jobId);
    await worker(); assert.equal((await service.job(operator, jobId)).status, 'completed');
    const first = (await service.builds.list(operator))[0]; assert.ok(first); assert.equal(first.status, 'in_progress'); assert.equal(first.artifactProvenance, 'unestablished');
    status = 'completed'; conclusion = 'success'; updatedAt = now();
    await service.builds.request(operator, { ...input, id: 'build-complete' }); await worker();
    const complete = (await service.builds.list(operator))[0]; assert.ok(complete); assert.equal(complete.conclusion, 'success'); assert.equal(complete.evidenceIds.length, 2);
    status = 'queued'; conclusion = null; updatedAt = new Date(Date.now() - 20000).toISOString();
    await service.builds.request(operator, { ...input, id: 'build-old' }); await worker();
    assert.equal((await service.builds.list(operator))[0]?.status, 'completed');
    status = 'completed'; conclusion = 'failure'; updatedAt = now();
    const conflicting = await service.builds.request(operator, { ...input, id: 'build-conflict' }); await worker(); assert.equal((await service.job(operator, conflicting)).error, 'BUILD_TERMINAL_STATE_CONFLICT');
    assert.equal((await service.builds.list(operator))[0]?.conclusion, 'success');
    attempt = 2; const second = await service.builds.request(operator, { ...input, id: 'build-attempt-two', runAttempt: 2 }); await worker(); assert.equal((await service.job(operator, second)).status, 'completed'); assert.equal((await service.builds.list(operator)).length, 2);
    await assert.rejects(service.builds.request({ ...operator, permissions: new Set(['read', 'assess']) }, input), /SCOPE_OR_PERMISSION/);
    assert.deepEqual(await service.builds.list({ ...operator, scope: { ...scope, applicationIds: ['another-app'] } }), []);
    await assert.rejects(service.job({ ...operator, permissions: new Set(['read']) }, jobId), /SCOPE_OR_PERMISSION/);
    assert.equal(await db.entity.count({ where: { kind: 'artifact' } }), 0); assert.equal((await records.findings(operator))[0]?.occurrences[0]?.runtimeState, 'affected');
    attempt = 1; conclusion = 'success'; cancelId = await service.builds.request(operator, { ...input, id: 'build-cancel' }); await worker(); assert.equal((await service.job(operator, cancelId)).cancelRequested, true); assert.equal((await service.job(operator, cancelId)).error, 'BUILD_OBSERVATION_LEASE_LOST_OR_CANCELED'); cancelId = null;
    const interrupted = await service.builds.request(operator, { ...input, id: 'build-interrupted' });
    await db.job.update({ where: { id: interrupted }, data: { status: 'running', leaseOwner: 'dead-worker', leaseUntil: new Date(0), deadline: new Date(0), cancelRequested: true } });
    assert.equal(await claim(db, 'replacement'), null); assert.equal((await service.job(operator, interrupted)).status, 'unknown');
    const observer = { ...operator, permissions: new Set<'read' | 'evidence' | 'recover'>(['read', 'evidence', 'recover']) };
    const observationJob = await service.reconcileJob(observer, interrupted); await worker(); assert.equal((await service.job(operator, observationJob)).status, 'completed'); assert.equal((await service.job(operator, interrupted)).status, 'completed'); assert.equal((await service.job(operator, interrupted)).cancelRequested, true); assert.equal((await service.job(operator, interrupted)).deadline, new Date(0).toISOString()); assert.equal(buildSchema.parse((await service.job(operator, interrupted)).result).id, first.id);
    outage = true; const failed = await service.builds.request(operator, { ...input, id: 'build-outage' }); await worker(); assert.equal((await service.job(operator, failed)).status, 'failed'); assert.equal((await service.builds.list(operator)).length, 2); outage = false;
    const staleLease = await service.builds.request(operator, { ...input, id: 'build-stale-lease' }); duringRead = async () => { await db.job.update({ where: { id: staleLease }, data: { leaseUntil: new Date(0) } }); }; await worker(); assert.equal((await service.job(operator, staleLease)).status, 'running'); duringRead = undefined;
    const revoked = await service.builds.request(operator, { ...input, id: 'build-revoked' }); duringRead = async () => { await records.entity(operator, { ...binding, buildDefinitions: [] }); }; await worker(); assert.equal((await service.job(operator, revoked)).error, 'BUILD_DEFINITION_OR_BRANCH_NOT_AUTHORIZED'); duringRead = undefined;
    await assert.rejects(service.builds.request(operator, { ...input, id: 'build-unapproved' }), /BUILD_DEFINITION_OR_BRANCH_NOT_AUTHORIZED/);
    const api = createApi(service, async () => operator); const allowed = await api.request('/api/v1/builds', { headers: { authorization: 'Bearer fixture-product-token' } }); assert.equal(allowed.status, 200); assert.equal(z.array(buildSchema).parse(await allowed.json()).length, 2);
    assert.equal((await api.request('/api/v1/builds')).status, 401);
    const denied = createApi(service, async () => ({ ...operator, permissions: new Set(['read']) })); assert.equal((await denied.request('/api/v1/builds', { headers: { authorization: 'Bearer fixture-product-token' } })).status, 403);
    assert.ok(methods.every(method => method === 'GET'));
  });

  await t.test('durable campaigns wait for independent canary verification within the original deadline', async () => {
    const { service, magnus } = await reset(); const initial = plan(); const first = initial.actions[0]; assert.ok(first);
    const value: Plan = { ...initial, actions: [...initial.actions, { ...first, id: 'after-canary', dependsOn: ['fixture-action'] }] };
    const proposed = await service.propose(coordinator, value); await service.publish(coordinator, value.id, 1); await service.decide(operator, { planId: value.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: value.expiresAt });
    const jobId = await service.execute(coordinator, value.id, { revision: 1, digest: proposed.digest }); const before = await service.job(operator, jobId);
    await tick(service, 'fixture-verification-waiter', new AbortController().signal);
    for (let attempt = 0; attempt < 100; attempt++) { if ((await service.job(operator, jobId)).error === 'ACTION_VERIFICATION_REQUIRED') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal((await service.job(operator, jobId)).error, 'ACTION_VERIFICATION_REQUIRED'); assert.equal(magnus.requests.length, 1);
    assert.equal((await service.job(operator, jobId)).status, 'queued');
    await service.profile(operator, { id: 'fixture-wait-profile', version: '1', platform: 'ubuntu-24.04', rules: [{ id: 'inventory-response', explanation: 'Observe the fixture inventory independently', capability: 'inventory.v1', field: 'exitCode', expected: 0, actionVersion: 'inventory.v1' }] });
    const assessmentId = await service.assess(coordinator, { id: 'fixture-independent-canary-assessment', scope, targetIds: ['fixture-node'], profileId: 'fixture-wait-profile', profileVersion: '1', deadline: later() });
    await tick(service, 'fixture-independent-assessment-worker', new AbortController().signal); assert.equal((await service.job(operator, assessmentId)).status, 'completed');
    const proof = { ...evidence(), id: 'canary-independent-evidence', content: { findingIdentity: finding().identity, securityCheckPassed: true, runningStateVerified: true } }; await service.evidence(operator, proof);
    await service.verify(operator, { id: 'fixture-verification', occurrenceId: occurrence().id, dimension: 'runtime', result: 'pass', method: proof.method, evidenceIds: [proof.id], coverage: occurrence().coverage, revision: null, artifactDigest: null, targetId: 'fixture-node', healthPassed: true, observedAt: now(), independent: true, consumerMigrationVerified: false });
    await new Promise(resolve => setTimeout(resolve, 2100)); await tick(service, 'fixture-resumed-canary-worker', new AbortController().signal); const completed = await service.job(operator, jobId); assert.equal(completed.status, 'completed'); assert.equal(completed.error, null); assert.equal(completed.deadline, before.deadline); assert.equal(magnus.requests.filter(request => request.planId === value.id).length, 2);
  });

  await t.test('failed canary verification pauses a waiting campaign before another native dispatch', async () => {
    const { service, magnus } = await reset(); const initial = plan(); const first = initial.actions[0]; assert.ok(first);
    const value: Plan = { ...initial, actions: [...initial.actions, { ...first, id: 'after-canary', dependsOn: ['fixture-action'] }] };
    const proposed = await service.propose(coordinator, value); await service.publish(coordinator, value.id, 1); await service.decide(operator, { planId: value.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: value.expiresAt });
    const jobId = await service.execute(coordinator, value.id, { revision: 1, digest: proposed.digest }); await tick(service, 'fixture-failed-canary-waiter', new AbortController().signal);
    for (let attempt = 0; attempt < 100; attempt++) { if ((await service.job(operator, jobId)).error === 'ACTION_VERIFICATION_REQUIRED') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(magnus.requests.length, 1);
    await service.verify(operator, { id: 'canary-failed', occurrenceId: occurrence().id, dimension: 'runtime', result: 'fail', method: evidence().method, evidenceIds: [evidence().id], coverage: occurrence().coverage, revision: null, artifactDigest: null, targetId: 'fixture-node', healthPassed: false, observedAt: now(), independent: true, consumerMigrationVerified: false });
    await new Promise(resolve => setTimeout(resolve, 2100)); await tick(service, 'fixture-failed-canary-resumed', new AbortController().signal); assert.equal((await service.job(operator, jobId)).error, 'CAMPAIGN_PAUSED'); assert.equal(magnus.requests.length, 1); assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: value.campaignId } })).paused, true);
  });

  await t.test('repeated credential locations retain distinct immutable evidence through scan ingestion', async () => {
    const { service, magnus } = await reset();
    const original = target(); if (original.kind !== 'target') throw new Error('Fixture worker required');
    const worker = { ...original, targetKind: 'worker' as const, capabilities: ['embermend:repository-scan.v1'] };
    await service.entity(operator, worker);
    magnus.capabilities = async () => ({ protocol: 1, installationId: 'fixture-magnus', serviceVersion: 'fixture', actions: ['repository-scan.v1'], targets: [worker], observedAt: now() });
    const provenance = { source: 'fixture', assurance: 'established', evidenceIds: [], observedAt: now() };
    await service.entity(operator, { id: 'fixture-repository', kind: 'repository', scope: { ...scope, targetIds: [] }, label: 'Fixture repository', provenance, provider: 'github', providerInstance: 'https://github.com', providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', environment: 'lab', accessRevision: 1 });
    await service.entity(operator, { id: 'fixture-source-binding', kind: 'source-binding', label: 'Fixture application', scope: { ...scope, targetIds: [] }, provenance, repositoryId: 'fixture-repository', applicationId: 'fixture-app', includedPaths: ['apps/api'], excludedPaths: [], maintainedBranches: ['main'], buildDefinitions: [], modelPolicy: { providerRefs: ['fixture-model'], allowRemote: false, allowExecution: false } });
    magnus.dispatch = async request => {
      magnus.requests.push(request);
      const locations = [{ path: 'apps/api/first.ts', line: 1 }, { path: 'apps/api/first.ts', line: 2 }, { path: 'apps/api/second.ts', line: 1 }];
      return { operationId: request.operationId, requestDigest: digest(request), targetId: request.action.targetId, state: 'completed', evidenceIds: [], ownershipReleased: true, observedAt: now(), result: { scanResult: { scannerVersion: 'fixture', profile: 'typescript-security.v1', modelRef: 'fixture-model', commit: 'a'.repeat(40), operationId: request.operationId, languages: ['typescript'], assessedClasses: ['secret'], state: 'completed', coverage: { status: 'complete', requested: ['apps/api/first.ts', 'apps/api/second.ts'], examined: ['apps/api/first.ts', 'apps/api/second.ts'], excluded: [], failures: [], mode: 'full', observedAt: now() }, candidates: locations.map(location => ({ ...location, fingerprint: 'd'.repeat(64), component: 'fixture-app', symbol: '<module>', weakness: 'secret', title: 'Credential-shaped literal', evidence: 'Value withheld', assumptions: ['Owner validation required'], severity: 'high', confidence: 0.8, validation: 'candidate' })) } } };
    };
    const request = scanRequestSchema.parse({ repositoryId: 'fixture-repository', providerId: '123', commit: 'a'.repeat(40), applicationId: 'fixture-app', scope, branch: 'main', pullRequest: null, includedPaths: ['apps/api'], excludedPaths: [], profile: 'typescript-security.v1', mode: 'full', workerTargetId: worker.id, operationId: 'fixture-multi-location-scan', deadline: later(), cancellationId: 'fixture-scan-cancel', maxFiles: 10, maxBytes: 10000, sourcePolicy: { providerRef: 'fixture-model', allowRemoteModel: false, allowRepositoryExecution: false } });
    const jobId = await service.scan(coordinator, request);
    await tick(service, 'fixture-multi-location-worker', new AbortController().signal);
    assert.equal((await service.job(operator, jobId)).status, 'completed');
    const result = (await service.findings(operator)).find(row => row.finding.kind === 'credential-exposure'); assert.ok(result);
    assert.equal(result.finding.evidenceIds.length, 3); assert.equal(result.occurrences.length, 3);
    assert.equal(new Set(result.occurrences.flatMap(item => item.evidenceIds)).size, 3);
    assert.deepEqual(result.finding.scope.targetIds, []);
    const secondScope = { ...scope, targetIds: ['fixture-second-worker'] }; const other = { ...operator, scope: secondScope }; const broad = { ...operator, scope: { ...scope, targetIds: [...scope.targetIds, ...secondScope.targetIds] } };
    const secondWorker = { ...worker, id: 'fixture-second-worker', magnusTargetId: 'fixture-second-worker', scope: secondScope }; await service.entity(broad, secondWorker);
    magnus.capabilities = async () => ({ protocol: 1, installationId: 'fixture-magnus', serviceVersion: 'fixture', actions: ['repository-scan.v1'], targets: [secondWorker], observedAt: now() });
    const repeated = await service.scan(other, { ...request, scope: secondScope, workerTargetId: secondWorker.id, operationId: 'fixture-replacement-worker-scan' }); await tick(service, 'fixture-replacement-source-worker', new AbortController().signal);
    assert.equal((await service.job(other, repeated)).status, 'completed');
    const retained = (await service.findings(other)).find(row => row.finding.id === result.finding.id); assert.ok(retained); assert.equal(retained.finding.evidenceIds.length, 6); assert.equal(retained.occurrences.length, 3);
    const proof = await service.readEvidence(other, retained.finding.evidenceIds[0] ?? 'missing'); assert.equal(proof.source, 'ai-scanner'); assert.equal(typeof proof.content['operationId'], 'string'); await assert.rejects(service.readEvidence(other, evidence().id), /SCOPE_OR_PERMISSION_DENIED/);

  });

  await t.test('application-level source findings retain target-scoped runtime evidence controls', async () => {
    const { service } = await reset(); const appScope = { ...scope, targetIds: [] }; const sourceOnly = { ...operator, scope: appScope };
    const sourceProof = { ...evidence(), id: 'application-source-proof', scope: appScope, subjectId: 'fixture-repository' }; await service.evidence(operator, sourceProof);
    const value = { ...finding(), id: 'application-code-finding', identity: 'e'.repeat(64), kind: 'code' as const, component: 'fixture-app', scope: appScope, evidenceIds: [sourceProof.id] };
    const sourceOccurrence = { ...occurrence(), id: 'application-source-occurrence', findingId: value.id, subjectId: 'fixture-repository', branch: 'main', revision: 'a'.repeat(40), sourceState: 'open' as const, runtimeState: 'unknown' as const, evidenceIds: [sourceProof.id] };
    await service.finding(operator, value, sourceOccurrence);
    const runtime = { ...occurrence(), id: 'application-runtime-occurrence', findingId: value.id, artifactDigest: 'd'.repeat(64) };
    await assert.rejects(service.finding(sourceOnly, { ...value, evidenceIds: [evidence().id] }, runtime), /SCOPE_OR_PERMISSION_DENIED/);
    await service.finding(operator, { ...value, evidenceIds: [evidence().id] }, runtime);
    const proof = { ...evidence(), id: 'application-runtime-proof', content: { deployedArtifactDigest: 'd'.repeat(64), securityCheckPassed: true, findingIdentity: value.identity } }; await service.evidence(operator, proof);
    const artifactProof = { ...sourceProof, id: 'application-immutable-artifact-proof', subjectId: 'application-artifact', content: { artifactDigest: 'd'.repeat(64), findingIdentity: value.identity, artifactSecurityCheckPassed: true, immutableArtifactVerified: true } }; await service.evidence(operator, artifactProof);
    const provenance = { source: 'fixture-review', assurance: 'established', evidenceIds: [artifactProof.id], observedAt: now() };
    await service.entity(operator, { id: 'application-artifact', kind: 'artifact', scope: appScope, label: 'Reviewed immutable fixture image', provenance, digest: 'd'.repeat(64), sourceRevisionIds: [], buildRunId: null, image: 'registry.example.com/fixture@sha256:' + 'd'.repeat(64) });
    await service.entity(operator, { id: 'application-deployment', kind: 'deployment', scope, label: 'Fixture deployment', provenance, applicationId: 'fixture-app', environment: 'lab', artifactIds: ['application-artifact'], targetIds: ['fixture-node'], configurationDigest: 'c'.repeat(64) });
    const check = { id: 'application-runtime-check', occurrenceId: runtime.id, dimension: 'runtime', result: 'pass', method: proof.method, evidenceIds: [proof.id], coverage: occurrence().coverage, revision: null, artifactDigest: 'd'.repeat(64), targetId: 'fixture-node', healthPassed: true, observedAt: now(), independent: true, consumerMigrationVerified: false };
    await assert.rejects(service.verify(sourceOnly, check), /SCOPE_OR_PERMISSION_DENIED/);
    await service.verify(operator, check);
    const retained = (await service.findings(operator)).find(row => row.finding.id === value.id); assert.equal(retained?.occurrences.find(item => item.id === runtime.id)?.runtimeState, 'verified-resolved'); assert.equal(retained?.occurrences.find(item => item.id === sourceOccurrence.id)?.sourceState, 'open');
  });

  await t.test('temporary container repairs cannot close code, dependency or image defects in the controlling artifact', async () => {
    for (const kind of ['code', 'dependency', 'image'] as const) {
      const { service } = await reset(); const appScope = { ...scope, targetIds: [] }; const artifactDigest = 'd'.repeat(64);
      const value = { ...finding(), kind, id: 'fixture-artifact-finding', identity: 'e'.repeat(64), component: 'fixture-app', scope: appScope };
      const hostProof = { ...evidence(), id: 'fixture-live-container-proof', content: { findingIdentity: value.identity, deployedArtifactDigest: artifactDigest, securityCheckPassed: true, healthPassed: true, temporaryContainerChange: true } }; await service.evidence(operator, hostProof);
      const occurrence = { id: 'fixture-artifact-occurrence', findingId: value.id, subjectId: 'fixture-node', branch: null, revision: null, artifactDigest, sourceState: 'open', runtimeState: 'affected', coverage: { status: 'complete', requested: ['fixture-node'], examined: ['fixture-node'], excluded: [], failures: [], mode: 'full', observedAt: now() }, evidenceIds: [hostProof.id], recurrenceOf: null };
      await service.finding(operator, { ...value, evidenceIds: [hostProof.id], scope }, occurrence);
      const provenance = { source: 'fixture-build', assurance: 'established', evidenceIds: [], observedAt: now() };
      const artifact = { id: 'fixture-controlling-artifact', kind: 'artifact', scope: appScope, label: 'Immutable controlling image', provenance, digest: artifactDigest, sourceRevisionIds: [], buildRunId: null, image: 'registry.example.com/fixture@sha256:' + artifactDigest }; await service.entity(operator, artifact);
      await service.entity(operator, { id: 'fixture-controlling-deployment', kind: 'deployment', scope, label: 'Fixture deployment', provenance, applicationId: 'fixture-app', environment: 'lab', artifactIds: [artifact.id], targetIds: ['fixture-node'], configurationDigest: 'c'.repeat(64) });
      const check = { id: 'fixture-container-only-verification', occurrenceId: occurrence.id, dimension: 'runtime', result: 'pass', method: hostProof.method, evidenceIds: [hostProof.id], coverage: occurrence.coverage, revision: null, artifactDigest, targetId: 'fixture-node', healthPassed: true, observedAt: hostProof.observedAt, independent: true, consumerMigrationVerified: false };
      await assert.rejects(service.verify(operator, check), /CONTROLLING_ARTIFACT_SECURITY_EVIDENCE_REQUIRED/); assert.equal((await service.findings(operator)).find(f => f.finding.id === value.id)?.occurrences[0]?.runtimeState, 'affected');
      await service.verify(operator, { ...check, id: 'fixture-container-mitigation', dimension: 'mitigation' }); assert.equal((await service.findings(operator)).find(f => f.finding.id === value.id)?.occurrences[0]?.runtimeState, 'verified-mitigated');
      const immutableProof = { ...evidence(), id: 'fixture-immutable-artifact-security', scope: appScope, subjectId: artifact.id, content: { findingIdentity: value.identity, artifactDigest, artifactSecurityCheckPassed: true, immutableArtifactVerified: true } }; await service.evidence(operator, immutableProof);
      await service.entity(operator, { ...artifact, provenance: { ...provenance, evidenceIds: [immutableProof.id] } }); await service.verify(operator, { ...check, id: 'fixture-immutable-artifact-verification' });
      const retained = (await service.findings(operator)).find(f => f.finding.id === value.id)?.occurrences[0]; assert.ok(retained); assert.equal(retained.runtimeState, 'verified-resolved'); assert.equal(retained.sourceState, 'open');
    }
  });

  await t.test('queued source work rechecks disclosure, execution and path policy before native admission', async () => {
    const { service, magnus } = await reset(); const initial = target(); if (initial.kind !== 'target') throw new Error('Fixture worker required');
    const actions = ['repository-scan.v1', 'repository-prepare.v1', 'repository-source.v1']; const worker = { ...initial, targetKind: 'worker' as const, capabilities: actions.map(value => 'embermend:' + value) };
    await service.entity(operator, worker); const provenance = { source: 'fixture-policy-review', assurance: 'established', evidenceIds: [], observedAt: now() };
    await service.entity(operator, { id: 'fixture-source-repository', kind: 'repository', scope, label: 'Fixture repository', provenance, provider: 'github', providerInstance: 'https://github.com', providerId: '123', owner: 'fixture-owner', name: 'fixture-repository', environment: 'lab', accessRevision: 1 });
    const binding = { id: 'fixture-source-policy', kind: 'source-binding', label: 'Scoped application', scope, provenance, repositoryId: 'fixture-source-repository', applicationId: 'fixture-app', includedPaths: ['apps/api'], excludedPaths: [], maintainedBranches: ['main'], buildDefinitions: [], modelPolicy: { providerRefs: ['fixture-model'], allowRemote: false, allowExecution: true } };
    const before = digest(await service.findings(operator));
    for (const kind of ['scan', 'preparation', 'source']) {
      await service.entity(operator, binding);
      const common = { repositoryId: 'fixture-source-repository', providerId: '123', applicationId: 'fixture-app', scope, workerTargetId: worker.id, deadline: later() };
      const jobId = kind === 'scan' ? await service.scan(operator, { ...common, commit: 'a'.repeat(40), branch: 'main', pullRequest: null, includedPaths: ['apps/api'], excludedPaths: [], profile: 'typescript-security.v1', mode: 'full', operationId: 'policy-revoked-scan', cancellationId: 'fixture-cancel', maxFiles: 10, maxBytes: 10000, sourcePolicy: { providerRef: 'fixture-model', allowRemoteModel: false, allowRepositoryExecution: false } }) : kind === 'preparation' ? await service.prepare(operator, { ...common, id: 'policy-revoked-preparation', baseCommit: 'a'.repeat(40), branch: 'main', includedPaths: ['apps/api'], excludedPaths: [], edits: [{ path: 'apps/api/new.ts', beforeDigest: null, content: 'export {};' }], validationProfileId: 'fixture-validation' }) : await service.source(operator, { ...common, id: 'policy-revoked-source', commit: 'a'.repeat(40), paths: ['apps/api/server.ts'] });
      magnus.capabilities = async () => {
        await service.entity(operator, { ...binding, ...(kind === 'source' ? { excludedPaths: ['apps/api'] } : { modelPolicy: { ...binding.modelPolicy, ...(kind === 'scan' ? { providerRefs: [] } : { allowExecution: false }) } }) });
        return { protocol: 1, installationId: 'fixture-magnus', serviceVersion: 'fixture', actions, targets: [worker], observedAt: now() };
      };
      await tick(service, 'fixture-policy-revoked-' + kind, new AbortController().signal);
      const job = await service.job(operator, jobId); assert.equal(job.status, 'failed', kind); assert.equal(job.error, 'SOURCE_ADMISSION_CHANGED_BEFORE_DISPATCH', kind); assert.equal(magnus.requests.length, 0); assert.equal(digest(await service.findings(operator)), before);
      assert.equal((await db.audit.count({ where: { subjectId: jobId, operation: 'source.admission-refused' } })), 1);
    }
  });

  await t.test('unknown-owner settlement requires a fresh bound independent review and a separate explicit approval', async () => {
    const { service, magnus } = await reset();
    const host = target(); if (host.kind !== 'target') throw new Error('Fixture host required');
    const capable = { ...host, capabilities: [...host.capabilities, 'embermend:execution-settle.v1'] };
    await service.entity(operator, capable);
    magnus.capabilities = async () => ({ protocol: 1, installationId: 'fixture-magnus', serviceVersion: 'fixture', actions: ['execution-settle.v1'], targets: [capable], observedAt: now() });
    const independent = { ...operator, id: 'fixture-independent-reviewer' };
    const reviewer = { ...operator, id: 'fixture-separate-approver' };
    const content = { originalOperationId: 'original-unknown', originalRequestDigest: 'b'.repeat(64), nativeCommandId: 'original-native', nativeRequestDigest: 'c'.repeat(64), originalOutcome: 'unknown', disposition: 'effects_verified', actionVersion: 'reboot.v1', independent: true, executionGroupEmpty: true, rebootScheduleAbsent: true, rootlessContainerAbsent: true, workspaceUnmounted: true, observedBootId: 'a4bd788c-b589-48fc-a95c-f0eeaf72b270' };
    const review = { ...evidence(), id: 'owner-review', method: 'owner-settlement-review.v1', source: 'operator-technical-review', content };
    await service.evidence(independent, review);
    const makePlan = (id: string, evidenceId = review.id, evidenceDigest = digest(content)): Plan => ({ ...plan(), id, campaignId: id, evidenceIds: [evidenceId], actions: [{ id: 'settle', version: 'execution-settle.v1', class: 'recovery', targetId: host.id, targetKind: 'host', requiredCapabilities: ['embermend:execution-settle.v1'], parameters: { originalOperationId: content.originalOperationId, originalRequestDigest: content.originalRequestDigest, nativeCommandId: content.nativeCommandId, nativeRequestDigest: content.nativeRequestDigest, evidenceId, evidenceDigest, disposition: 'effects_verified', originalOutcome: 'unknown' }, preconditions: { environment: 'lab' }, dependsOn: [], verificationIds: ['fixture-recovery-verification'], recovery: 'Settle current ownership only; the historical outcome remains unknown.', expectedRevision: null, patchDigest: null, disruption: 'none' }] });
    const propose = async (p: Plan, approver = reviewer) => { const proposed = await service.propose(coordinator, p); await service.publish(coordinator, p.id, 1); await service.decide(approver, { planId: p.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: p.expiresAt }); return p; };
    const valid = await propose(makePlan('owner-valid'));
    const refusedActors: Actor[] = [coordinator, { ...operator, permissions: new Set(['read', 'execute']) }, { ...coordinator, permissions: new Set([...coordinator.permissions, 'recover']) }];
    for (const actor of refusedActors) await assert.rejects(service.dispatch(actor, valid.id, 'settle'), /SCOPE_OR_PERMISSION_DENIED|OPERATOR_AUTHORITY_REQUIRED/);
    const self = await propose(makePlan('owner-existing-operator-approval'), operator);
    const wrong = await propose(makePlan('owner-wrong-digest', review.id, 'd'.repeat(64))); await assert.rejects(service.dispatch(operator, wrong.id, 'settle'), /FRESH_INDEPENDENT/);
    await service.evidence(operator, { ...review, id: 'owner-self-review' });
    const selfReview = await propose(makePlan('owner-operator-technical-review', 'owner-self-review'), operator);
    const staleReview = { ...review, id: 'owner-stale-review', observedAt: new Date(Date.now() - 301000).toISOString() }; await service.evidence(independent, staleReview);
    const stale = await propose(makePlan('owner-stale', staleReview.id)); await assert.rejects(service.dispatch(operator, stale.id, 'settle'), /FRESH_INDEPENDENT/);
    assert.equal(magnus.requests.length, 0);
    const before = digest(await service.findings(operator)); const receipt = await service.dispatch(operator, valid.id, 'settle'); assert.equal(receipt.state, 'completed'); assert.equal(magnus.requests.length, 1); assert.equal(digest(await service.findings(operator)), before);
    await service.dispatch(operator, valid.id, 'settle'); assert.equal(magnus.requests.length, 1);
    assert.equal((await service.dispatch(operator, self.id, 'settle')).state, 'completed');
    assert.equal((await service.dispatch(operator, selfReview.id, 'settle')).state, 'completed');
    assert.equal(magnus.requests.length, 3);
  });

  await t.test('settled unknown outcomes stop observation without inventing clean results or restoring held ownership', async () => {
    const { service, magnus } = await reset(); const p = plan(); const proposed = await service.propose(coordinator, p); await service.publish(coordinator, p.id, 1); await service.decide(operator, { planId: p.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: p.expiresAt }); magnus.loseReply = true;
    await assert.rejects(service.dispatch(coordinator, p.id, 'fixture-action'), /UNKNOWN_EXECUTION/);
    const execution = await db.execution.findFirstOrThrow(); const originalReceipt = magnus.receipts.get(execution.id); assert.ok(originalReceipt);
    const settled: Receipt = { ...originalReceipt, state: 'unknown', ownershipReleased: true, result: { ownershipSettled: true, originalOutcome: 'unknown' } };
    magnus.receipt = async () => settled; await service.reconcile(operator, execution.id);
    magnus.receipt = async () => ({ ...settled, state: 'running', ownershipReleased: false, result: {} }); assert.deepEqual(await service.reconcile(operator, execution.id), settled);
    const assessment = await service.assess(coordinator, { id: 'settled-assessment', scope, targetIds: ['fixture-node'], profileId: 'fixture-profile', profileVersion: '1', deadline: later() });
    await tick(service, 'fixture-settled-assessment', new AbortController().signal);
    const job = await db.job.findUniqueOrThrow({ where: { id: assessment } }); const ledger = z.object({ operations: z.array(z.object({ request: z.unknown(), operationId: z.string(), requestDigest: z.string() }).passthrough()) }).parse(job.result); const entry = ledger.operations[0]; assert.ok(entry);
    await db.job.update({ where: { id: assessment }, data: { status: 'unknown' } });
    let reads = 0; magnus.receipt = async () => { reads++; return { ...settled, operationId: entry.operationId, requestDigest: entry.requestDigest }; };
    const before = digest(await service.findings(operator)); const observation = await service.reconcileJob(operator, assessment); await tick(service, 'fixture-settled-observer', new AbortController().signal);
    const observed = await service.job(operator, observation); assert.equal(observed.error, 'OWNER_SETTLED_ORIGINAL_OUTCOME_UNKNOWN'); assert.equal(observed.status, 'unknown'); assert.equal(reads, 1); assert.equal((await service.job(operator, assessment)).status, 'unknown'); assert.equal(digest(await service.findings(operator)), before); assert.equal(magnus.requests.length, 2);
  });

  await t.test('confirmed failed campaign observation is terminal failure while preserving deadline and cancellation', async () => {
    const { service, magnus } = await reset(); const p = plan(); const proposed = await service.propose(coordinator, p); await service.publish(coordinator, p.id, 1); await service.decide(operator, { planId: p.id, revision: 1, digest: proposed.digest, decision: 'approve', expiresAt: p.expiresAt }); magnus.loseReply = true;
    const originalJob = await service.execute(coordinator, p.id, { revision: 1, digest: proposed.digest }); await tick(service, 'fixture-lost-campaign', new AbortController().signal);
    assert.equal((await service.job(operator, originalJob)).status, 'unknown'); const execution = await db.execution.findFirstOrThrow(); const retained = magnus.receipts.get(execution.id); assert.ok(retained);
    await db.job.update({ where: { id: originalJob }, data: { deadline: new Date(0), cancelRequested: true } });
    magnus.receipt = async () => ({ ...retained, state: 'failed', ownershipReleased: true, result: { superseded: true, originalOutcome: 'unknown' } });
    const observation = await service.reconcileJob(operator, originalJob); await tick(service, 'fixture-confirmed-failure', new AbortController().signal);
    assert.equal((await service.job(operator, observation)).status, 'failed'); const original = await service.job(operator, originalJob); assert.equal(original.status, 'failed'); assert.equal(original.error, 'CAMPAIGN_FAILED_CONFIRMED'); assert.equal(original.cancelRequested, true); assert.equal(original.deadline, new Date(0).toISOString()); assert.equal(magnus.requests.length, 1);
  });

});
