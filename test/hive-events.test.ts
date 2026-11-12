import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHiveEvent } from '@hivemagnus/hive-common/contracts';
import { HIVE_EVENTS_PATH as SHARED_PATH } from '@hivemagnus/hive-common/events';
import { HIVE_EVENTS_PATH, hiveEventSchema } from '@hivemagnus/embermend-contracts';
import { decodeFeedPosition, encodeFeedPosition, eventKey, recommendationSeverity } from '@hivemagnus/embermend-core';

test('recommendation severity follows finding severity and priority', () => {
  assert.equal(recommendationSeverity([]), 'info');
  assert.equal(recommendationSeverity([{ severity: 'medium', priority: 40 }]), 'info');
  assert.equal(recommendationSeverity([{ severity: 'low', priority: 10 }, { severity: 'high', priority: 55 }]), 'warning');
  assert.equal(recommendationSeverity([{ severity: 'medium', priority: 60 }]), 'warning');
  assert.equal(recommendationSeverity([{ severity: 'critical', priority: 70 }]), 'critical');
  assert.equal(recommendationSeverity([{ severity: 'high', priority: 85 }]), 'critical');
});

test('event keys are stable and always fit a HiveEvent ID', () => {
  assert.equal(eventKey('fixture-plan'), 'fixture-plan');
  const unsafe = 'plan with spaces/and:colons';
  assert.equal(eventKey(unsafe), eventKey(unsafe));
  assert.match(eventKey(unsafe), /^h-[a-f0-9]{32}$/);
  assert.match(eventKey('x'.repeat(200)), /^h-[a-f0-9]{32}$/);
});

test('feed cursors round-trip and reject tampering with 400', () => {
  const position = { occurredAt: '2026-11-12T10:00:00.000Z', id: 'embermend:plan:p:r1:created' };
  assert.deepEqual(decodeFeedPosition(encodeFeedPosition(position)), position);
  for (const cursor of ['!!', 'e30', encodeFeedPosition({ occurredAt: 'yesterday', id: 'x' })]) assert.throws(() => decodeFeedPosition(cursor), (error: unknown) => error instanceof Error && error.message === 'INVALID_FEED_CURSOR');
});

test('browser contract agrees with the shared HiveEvent validator', () => {
  assert.equal(HIVE_EVENTS_PATH, `/api${SHARED_PATH}`);
  const event = { id: 'embermend:plan:fixture-plan:r1:created', product: 'embermend', type: 'recommendation.created', severity: 'warning', title: 'Remediation recommended: Protect service configuration', summary: 'Revision 1 proposes 1 action on 1 target for 1 finding. Impact: none', occurredAt: '2026-11-12T10:00:00.000Z', subject: { nodeId: 'fixture-node' }, link: { product: 'embermend', path: '/?page=embermend&plan=fixture-plan' }, sourceRef: 'fixture-plan' };
  assert.ok(validateHiveEvent(event, { strict: true }).ok);
  assert.deepEqual(hiveEventSchema.parse(event), event);
  assert.equal(hiveEventSchema.safeParse({ ...event, extra: true }).success, false);
});
