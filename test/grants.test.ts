import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileGrants, grantsFromEnv } from '../services/runtime/src/grants.js';
import { grantAuthority } from '../services/runtime/src/authority.js';
import { operator, scope } from './fixtures.js';

const grant = (permissions: string[]) => ({ subject: operator.id, kind: 'operator', permissions, scope });

test('a grants file is reloaded on change, so revocation needs no restart, and a bad version keeps the last valid grants', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'embermend-grants-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'grants.json');
  // Atomic replacement, as documented: write a temporary file and rename it.
  const write = async (value: unknown) => { await writeFile(`${path}.tmp`, typeof value === 'string' ? value : JSON.stringify(value)); await rename(`${path}.tmp`, path); };
  await write([grant(['read', 'assess'])]);
  let clock = 0; const grants = fileGrants(path, { checkMs: 1000, now: () => clock });
  const authority = grantAuthority(grants);
  assert.equal(authority(operator).allowed, true);
  await write([]);
  assert.equal(authority(operator).allowed, true, 'checked at most once per interval');
  clock += 1000; const revoked = authority(operator);
  assert.equal(revoked.allowed, false); assert.equal(!revoked.allowed && revoked.reason, 'ACTOR_GRANT_REVOKED');
  await write([grant(['read'])]); clock += 1000; assert.deepEqual(grants().map(item => item.permissions), [['read']]);
  const writes = t.mock.method(process.stderr, 'write', () => true);
  try { await write('{ not json'); clock += 1000; assert.deepEqual(grants().map(item => item.permissions), [['read']]); await write([{ subject: 'x' }]); clock += 1000; assert.equal(grants().length, 1); }
  finally { writes.mock.restore(); }
  assert.ok(writes.mock.calls.some(call => String(call.arguments[0]).includes('grants.reload_failed')));
  await write([grant(['read', 'evidence'])]); clock += 1000; assert.deepEqual(grants().map(item => item.permissions), [['read', 'evidence']]);
  await assert.rejects(async () => { await write('[{"subject":1}]'); fileGrants(path); }, 'an invalid file at startup is refused');
});

test('exactly one grants setting is accepted', () => {
  assert.throws(() => grantsFromEnv({}), /exactly one/);
  assert.throws(() => grantsFromEnv({ EMBERMEND_IDENTITY_GRANTS: '[]', EMBERMEND_IDENTITY_GRANTS_FILE: '/nonexistent' }), /exactly one/);
  assert.deepEqual(grantsFromEnv({ EMBERMEND_IDENTITY_GRANTS: JSON.stringify([grant(['read'])]) })().length, 1);
});
