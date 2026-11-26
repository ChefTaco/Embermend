import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantAuthority, type Grants } from '../services/runtime/src/authority.js';
import { errorFields } from '../services/runtime/src/log.js';
import { DomainError } from '@hivemagnus/embermend-core';
import { coordinator, operator, scope } from './fixtures.js';

const grant = (changes: Partial<Grants[number]> = {}): Grants[number] => ({ subject: operator.id, kind: 'operator', permissions: [...operator.permissions], scope, ...changes });

test('stored authority needs one current grant of the same kind covering its scope', () => {
  for (const [grants, reason] of [
    [[], 'ACTOR_GRANT_REVOKED'],
    [[grant(), grant()], 'ACTOR_GRANT_REVOKED'],
    [[grant({ subject: coordinator.id })], 'ACTOR_GRANT_REVOKED'],
    [[grant({ kind: 'integration' })], 'ACTOR_KIND_CHANGED'],
    [[grant({ scope: { ...scope, installationId: 'other-installation' } })], 'ACTOR_SCOPE_REVOKED'],
    [[grant({ scope: { ...scope, applicationIds: [] } })], 'ACTOR_SCOPE_REVOKED'],
  ] satisfies Array<[Grants, string]>) assert.deepEqual(grantAuthority(grants)(operator), { allowed: false, reason });
});

test('permissions are intersected with the current grant and never widened', () => {
  const narrowed = grantAuthority([grant({ permissions: ['read', 'assess'] })])(operator);
  assert.equal(narrowed.allowed, true); if (!narrowed.allowed) return;
  assert.deepEqual([...narrowed.actor.permissions].sort(), ['assess', 'read']);
  assert.equal(narrowed.removed.length, operator.permissions.size - 2);
  assert.deepEqual(narrowed.actor.scope, scope);
  const stored = { ...operator, permissions: new Set(['read'] as const) };
  const wider = grantAuthority([grant({ scope: { ...scope, targetIds: [...scope.targetIds, 'another-node'] } })])(stored);
  assert.equal(wider.allowed, true); if (!wider.allowed) return;
  assert.deepEqual([...wider.actor.permissions], ['read']); assert.deepEqual(wider.removed, []); assert.deepEqual(wider.actor.scope, scope);
});

test('logged failures keep codes, never messages', () => {
  assert.deepEqual(errorFields(new DomainError('PLAN_CHANGED')), { errorCode: 'PLAN_CHANGED' });
  assert.deepEqual(errorFields(Object.assign(new Error('connect ECONNREFUSED postgresql://user:secret@db/x'), { code: 'ECONNREFUSED' })), { errorName: 'Error', errorCode: 'ECONNREFUSED' });
  assert.deepEqual(errorFields(new Error('PRODUCT_GRANT_REQUIRED')), { errorName: 'Error', reason: 'PRODUCT_GRANT_REQUIRED' });
  assert.deepEqual(errorFields('text'), { errorName: 'string' });
});
