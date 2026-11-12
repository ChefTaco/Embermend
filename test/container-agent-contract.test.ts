import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitySchema, operationRequestSchema, entitySchema, receiptSchema, type Action, type Entity } from '@hivemagnus/embermend-contracts';
import { assertTarget, requirePermission } from '@hivemagnus/embermend-core';
import { MagnusClient } from '@hivemagnus/embermend-integrations';
import { digest } from '@hivemagnus/embermend-store';
import { target, now, later, operator } from './fixtures.js';

const container = (): Extract<Entity, { kind: 'target' }> => {
  const value = entitySchema.parse({ ...target(), id: 'fixture-container-target', targetKind: 'container', magnusTargetId: 'fixture-container-enrollment', agentId: 'fixture-container-agent', parentHostId: 'fixture-host', workloadId: 'fixture-workload', instanceId: 'fixture-container-instance-a', executionNamespace: 'container:fixture-container-instance-a', scope: { installationId: 'fixture-installation', applicationIds: ['fixture-app'], targetIds: ['fixture-container-target'] }, capabilities: ['embermend:inventory.v1'] });
  if (value.kind !== 'target') throw new Error('Container target fixture required');
  return value;
};
const action = (): Action => ({ id: 'container-inventory', version: 'inventory.v1', class: 'assess', targetId: 'fixture-container-target', targetKind: 'container', requiredCapabilities: ['embermend:inventory.v1'], parameters: { sections: ['configuration'], profileId: 'container-posture.v1' }, preconditions: {}, dependsOn: [], verificationIds: ['container-assessment'], recovery: 'Observe the original scoped operation', expectedRevision: null, patchDigest: null, disruption: 'none' });

test('future container enrollment and operation contracts preserve the container identity and namespace', async () => {
  const identity = container(); assert.equal(identity.kind, 'target');
  assertTarget(action(), identity);
  const capability = capabilitySchema.parse({ protocol: 1, installationId: 'fixture-magnus', serviceVersion: 'fixture-contract', observedAt: now(), actions: ['inventory.v1'], targets: [identity] });
  const operation = operationRequestSchema.parse({ operationId: 'fixture-container-operation', installationId: capability.installationId, planId: 'fixture-plan', planRevision: 1, planDigest: 'a'.repeat(64), action: action(), authorizationRef: 'fixture-scoped-container-grant', expiresAt: later() });
  const paths: string[] = [];
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.endsWith('/capabilities')) return Response.json(capability);
    if (init?.method === 'POST') assert.deepEqual(operationRequestSchema.parse(JSON.parse(String(init.body))), operation);
    return Response.json(receiptSchema.parse({ operationId: operation.operationId, requestDigest: digest(operation), targetId: identity.id, state: 'completed', ownershipReleased: true, observedAt: now(), evidenceIds: ['fixture-container-evidence'], result: { executionNamespace: 'container:fixture-container-instance-a', instanceId: 'fixture-container-instance-a', coverage: 'container-only' } }));
  };
  const client = new MagnusClient('https://magnus.example.com', 'fixture-product-token-not-real', request);
  const seen = await client.capabilities(); assert.deepEqual(seen.targets[0], identity);
  const receipt = await client.dispatch(operation); assert.equal(receipt.targetId, identity.id); assert.equal(receipt.result['executionNamespace'], 'container:fixture-container-instance-a');
  assert.equal((await client.receipt(operation.operationId)).operationId, operation.operationId);
  assert.deepEqual(paths, ['/api/v1/embermend/capabilities', '/api/v1/embermend/operations', '/api/v1/embermend/operations/fixture-container-operation']);
});

test('a container-scoped principal and target cannot route host operations or inherit a replacement identity', () => {
  const identity = container(); const actor = { ...operator, scope: identity.scope };
  assert.throws(() => requirePermission(actor, 'execute', { ...identity.scope, targetIds: ['fixture-host'] }), /SCOPE_OR_PERMISSION_DENIED/);
  for (const version of ['reboot.v1', 'file-mode.v1', 'compose-deploy.v1']) assert.throws(() => assertTarget({ ...action(), version, class: version === 'reboot.v1' ? 'reboot' : version === 'compose-deploy.v1' ? 'deploy' : 'host-change', disruption: 'outage' }, identity), /ACTION_EFFECT_OR_TARGET_MISMATCH/);
  assert.throws(() => assertTarget(action(), { ...identity, enrollment: 'discovered' }), /TARGET_NOT_ELIGIBLE/);
  assert.throws(() => assertTarget(action(), { ...identity, lifecycle: 'retired' }), /TARGET_NOT_ELIGIBLE/);
  const replacement = entitySchema.parse({ ...identity, id: 'fixture-container-target-b', instanceId: 'fixture-container-instance-b', executionNamespace: 'container:fixture-container-instance-b' });
  assert.notEqual(digest(identity), digest(replacement));
  assert.throws(() => assertTarget(action(), replacement), /TARGET_IDENTITY_MISMATCH/);
});
