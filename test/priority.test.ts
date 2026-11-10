import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prioritize } from '@hivemagnus/embermend-core';
import { finding } from './fixtures.js';
test('priority records uncertainty and increases with business impact and age', () => {
  const now = new Date('2026-11-10T00:00:00Z');
  const fresh = prioritize(finding(), now.toISOString(), 'unknown', now);
  const critical = prioritize(finding(), '2026-09-01T00:00:00Z', 'critical', now);
  assert.ok(critical.priority > fresh.priority); assert.equal(fresh.risk?.exposure, 'unknown');
  assert.equal(fresh.risk?.fixAvailability, 'unknown'); assert.ok(fresh.risk?.factors.some(item => item.reason === 'exposure:unknown'));
  assert.equal(critical.risk?.firstSeenAt, '2026-09-01T00:00:00Z');
});
