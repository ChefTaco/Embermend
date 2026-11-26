import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { isOathweaveError, OathweaveError } from '@hivemagnus/hive-common/oathweave';
import { identityProviderUnavailable, oathweaveAuthenticator, OathweaveDirectory, roleAuthority, type OathweaveAccount, type RoleScopes } from '@hivemagnus/embermend-integrations';
import { oathweaveRoleAuthority } from '../services/runtime/src/authority.js';
import { authorityFromEnv, roleScopesFromEnv } from '../services/runtime/src/grants.js';
import { coordinator, operator, scope } from './fixtures.js';

const lab = { installationId: 'fixture-installation', applicationIds: ['fixture-app'], targetIds: ['fixture-node'] };
const scopes: RoleScopes = [
  { role: 'embermend-lab', scope: lab },
  { role: 'embermend-lab-extra', scope: { installationId: 'fixture-installation', applicationIds: ['fixture-app', 'other-app'], targetIds: ['other-node'] } },
  { role: 'embermend-prod', scope: { installationId: 'other-installation', applicationIds: [], targetIds: [] } },
];
const account = (roles: string[], permissions: string[], active = true): OathweaveAccount => ({ active, roles, permissions });

test('role-derived authority: permissions from embermend:* role permissions, scope from mapped roles', () => {
  const derived = roleAuthority(account(['embermend-lab', 'embermend-lab-extra', 'unmapped'], ['embermend:read', 'embermend:assess', 'embermend:audit:read', 'iam:users:read', 'embermend:unknown', 'read']), scopes);
  assert.deepEqual(derived, { ok: true, scope: { installationId: 'fixture-installation', applicationIds: ['fixture-app', 'other-app'], targetIds: ['fixture-node', 'other-node'] }, permissions: ['read', 'assess', 'audit:read'] });
  assert.deepEqual(roleAuthority(null, scopes), { ok: false, reason: 'OATHWEAVE_ACCOUNT_INACTIVE' });
  assert.deepEqual(roleAuthority(account(['embermend-lab'], ['embermend:read'], false), scopes), { ok: false, reason: 'OATHWEAVE_ACCOUNT_INACTIVE' });
  assert.deepEqual(roleAuthority(account(['unmapped'], ['embermend:read']), scopes), { ok: false, reason: 'OATHWEAVE_ROLE_SCOPE_REQUIRED' });
  assert.deepEqual(roleAuthority(account(['embermend-lab', 'embermend-prod'], ['embermend:read']), scopes), { ok: false, reason: 'OATHWEAVE_ROLE_SCOPE_AMBIGUOUS' });
  assert.deepEqual(roleAuthority(account(['embermend-lab'], []), scopes), { ok: true, scope: lab, permissions: [] });
  const many = (prefix: string) => Array.from({ length: 600 }, (_, index) => `${prefix}-${index}`);
  assert.deepEqual(roleAuthority(account(['a', 'b'], []), [{ role: 'a', scope: { ...lab, targetIds: many('a') } }, { role: 'b', scope: { ...lab, targetIds: many('b') } }]), { ok: false, reason: 'OATHWEAVE_ROLE_SCOPE_TOO_LARGE' });
});

/** A fake Oathweave admin API: users, groups and the token endpoint. */
function fakeOathweave() {
  const calls: string[] = [];
  const state = {
    users: new Map<string, { active: boolean; roles: Array<{ name: string; permissions: string[] }> }>([['fixture-operator', { active: true, roles: [{ name: 'embermend-lab', permissions: ['embermend:read'] }] }]]),
    groups: [{ id: 'fixture-group', members: ['fixture-operator'], roles: [{ name: 'embermend-approvers', permissions: ['embermend:approve', 'embermend:assess'] }] }],
    failUsers: 0, failGroups: false, expiredToken: false, tokens: 0, calls,
  };
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); state.calls.push(url.pathname);
    if (url.pathname === '/api/v1/oauth/token') { state.tokens++; assert.match(String(init?.body), /scope=iam%3Ausers%3Aread\+iam%3Agroups%3Aread/); return Response.json({ access_token: `fixture-directory-token-${state.tokens}`, expires_in: 300, token_type: 'Bearer' }); }
    const authorization = new Headers(init?.headers).get('authorization');
    if (state.expiredToken && authorization === 'Bearer fixture-directory-token-1') return new Response('{}', { status: 401 });
    const user = /^\/api\/v1\/users\/([^/]+)$/.exec(url.pathname);
    if (user?.[1]) {
      if (state.failUsers > 0) { state.failUsers--; return new Response('{}', { status: 502 }); }
      const id = decodeURIComponent(user[1]); const found = state.users.get(id);
      // Oathweave stores role permissions as JSON text.
      return found ? Response.json({ user: { id, email: 'person@example.com', active: found.active, roles: found.roles.map(role => ({ role: { id: role.name, name: role.name, permissions: JSON.stringify(role.permissions) } })), sessions: [] } }) : Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    if (state.failGroups) return new Response('{}', { status: 503 });
    if (url.pathname === '/api/v1/groups') return Response.json({ groups: state.groups.map(group => ({ id: group.id, name: group.id, memberCount: group.members.length })) });
    const group = /^\/api\/v1\/groups\/([^/]+)$/.exec(url.pathname); const found = state.groups.find(item => item.id === group?.[1]);
    if (found) return Response.json({ group: { id: found.id, members: found.members.map(userId => ({ id: `m-${userId}`, groupId: found.id, userId, user: { id: userId } })), roles: found.roles.map(role => ({ role: { id: role.name, name: role.name, label: role.name, permissions: JSON.stringify(role.permissions) } })) } });
    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  };
  return { state, request };
}
const directoryConfig = { apiUrl: 'https://identity.example.com/api/v1', tokenUrl: 'https://identity.example.com/api/v1/oauth/token', clientId: 'embermend-directory', clientSecret: 'fixture-directory-credential-of-32-characters' };

test('the directory reads direct and group roles, caches briefly, and reports outages as unavailable, never as revocation', async () => {
  const { state, request } = fakeOathweave(); let clock = 0;
  const directory = new OathweaveDirectory({ ...directoryConfig, cacheMs: 1000 }, request, () => clock);
  assert.deepEqual(await directory.lookup('fixture-operator'), { active: true, roles: ['embermend-lab', 'embermend-approvers'], permissions: ['embermend:read', 'embermend:approve', 'embermend:assess'] });
  const calls = state.calls.length; await directory.lookup('fixture-operator'); assert.equal(state.calls.length, calls, 'cached');
  for (const group of state.groups) group.members = []; clock += 1000;
  assert.deepEqual((await directory.lookup('fixture-operator'))?.roles, ['embermend-lab'], 'a group membership removed in Oathweave is seen after the cache interval');
  assert.equal(await directory.lookup('missing-user'), null);
  state.failUsers = 1; clock += 1000;
  await assert.rejects(directory.lookup('fixture-operator'), (error: unknown) => identityProviderUnavailable(error));
  assert.equal((await directory.lookup('fixture-operator'))?.active, true, 'a failed read is not cached');
  state.failGroups = true; clock += 1000;
  await assert.rejects(directory.lookup('fixture-operator'), (error: unknown) => identityProviderUnavailable(error));
  state.failGroups = false; state.expiredToken = true; clock += 1000;
  assert.equal((await directory.lookup('fixture-operator'))?.active, true, 'a refused token is replaced once');
  assert.equal(state.tokens, 2);
  assert.throws(() => new OathweaveDirectory({ ...directoryConfig, apiUrl: 'http://identity.example.com/api/v1' }), /HTTPS/);
});

test('an Oathweave user token gets its authority from current roles on every request; services keep their grants', async () => {
  const pair = await generateKeyPair('RS256'); const publicKey = await exportJWK(pair.publicKey); publicKey.kid = 'fixture-key'; const keys = createLocalJWKSet({ keys: [publicKey] });
  const userinfo: typeof fetch = async () => Response.json({ sub: 'fixture-operator' });
  let current: OathweaveAccount | null = account(['embermend-lab'], ['embermend:read', 'embermend:assess', 'embermend:approve']); let outage = false;
  const lookup = async () => { if (outage) throw new OathweaveError('identity_unavailable'); return current; };
  const auth = oathweaveAuthenticator({ issuer: 'https://identity.example.com', jwksUrl: 'https://identity.example.com/jwks', userinfoUrl: 'https://identity.example.com/userinfo', grants: [{ subject: 'fixture-coordinator', kind: 'coordinator', permissions: ['read', 'assess'], scope }], roles: { lookup, scopes } }, { keys, request: userinfo });
  const sign = async (subject: string, extra: Record<string, unknown>) => new SignJWT({ permissions: ['embermend:read', 'embermend:assess', 'embermend:evidence'], ...extra }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer('https://identity.example.com').setAudience('embermend').setSubject(subject).setJti('fixture-token-id').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const user = await sign('fixture-operator', { actorType: 'USER', sessionId: 'fixture-session', clientId: 'hivexui-embermend', roles: ['embermend-lab'] });
  const actor = await auth(user);
  // Held by both the token and the account's roles: approve is not on the token, evidence not on a role.
  assert.deepEqual({ ...actor, permissions: [...actor.permissions] }, { id: 'fixture-operator', kind: 'operator', scope: lab, permissions: ['read', 'assess'] });
  current = account(['embermend-lab'], ['embermend:read']);
  assert.deepEqual([...(await auth(user)).permissions], ['read'], 'a permission removed from the role applies to the same token');
  current = account(['unmapped'], ['embermend:read']);
  await assert.rejects(auth(user), /OATHWEAVE_ROLE_SCOPE_REQUIRED/, 'the role removed in Oathweave refuses the same token at once');
  current = null; await assert.rejects(auth(user), /OATHWEAVE_ACCOUNT_INACTIVE/);
  outage = true; await assert.rejects(auth(user), (error: unknown) => identityProviderUnavailable(error));
  await assert.rejects(auth(await sign('fixture-operator', { actorType: 'USER', sessionId: 'fixture-session', clientId: 'hivexui-embermend' })), /OPERATOR_USER_TOKEN_REQUIRED/);
  const machine = await auth(await sign('fixture-coordinator', { actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: 'fixture-coordinator' }));
  assert.equal(machine.kind, 'coordinator'); assert.deepEqual([...machine.permissions], ['read', 'assess']);
  await assert.rejects(auth(await sign('unknown-service', { actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: 'unknown-service' })), /EXPLICIT_UNIQUE_PRODUCT_GRANT_REQUIRED/);
});

test('stored operator work is rechecked against current Oathweave roles; revocation stops it, an outage only defers it', async () => {
  let current: OathweaveAccount | null = account(['embermend-lab'], [...operator.permissions].map(permission => `embermend:${permission}`));
  let outage = false;
  const authority = oathweaveRoleAuthority(async () => { if (outage) throw new OathweaveError('identity_unavailable'); return current; }, () => scopes, [{ subject: coordinator.id, kind: 'coordinator', permissions: [...coordinator.permissions], scope }]);
  const kept = await authority(operator); assert.equal(kept.allowed, true);
  current = account(['embermend-lab'], ['embermend:read', 'embermend:assess']);
  const narrowed = await authority(operator); assert.equal(narrowed.allowed, true);
  assert.deepEqual(narrowed.allowed && [...narrowed.actor.permissions].sort(), ['assess', 'read']);
  assert.equal(narrowed.allowed && narrowed.removed.length, operator.permissions.size - 2);
  current = account(['unmapped'], ['embermend:read']); assert.deepEqual(await authority(operator), { allowed: false, reason: 'ACTOR_GRANT_REVOKED' });
  current = account(['embermend-lab'], ['embermend:read'], false); assert.deepEqual(await authority(operator), { allowed: false, reason: 'ACTOR_GRANT_REVOKED' });
  current = null; assert.deepEqual(await authority(operator), { allowed: false, reason: 'ACTOR_GRANT_REVOKED' });
  current = account(['embermend-prod'], ['embermend:read']); assert.deepEqual(await authority(operator), { allowed: false, reason: 'ACTOR_SCOPE_REVOKED' });
  outage = true; await assert.rejects(Promise.resolve(authority(operator)), (error: unknown) => isOathweaveError(error) && identityProviderUnavailable(error));
  // Services are checked against their grants, without asking Oathweave.
  assert.equal((await authority(coordinator)).allowed, true);
  assert.deepEqual(await authority({ ...coordinator, id: 'other-coordinator' }), { allowed: false, reason: 'ACTOR_GRANT_REVOKED' });
});

const roleEnv = { EMBERMEND_AUTHORITY_SOURCE: 'oathweave', EMBERMEND_OATHWEAVE_ROLE_SCOPES: JSON.stringify(scopes), EMBERMEND_OATHWEAVE_API_URL: directoryConfig.apiUrl, EMBERMEND_OATHWEAVE_TOKEN_URL: directoryConfig.tokenUrl, EMBERMEND_OATHWEAVE_CLIENT_ID: directoryConfig.clientId, EMBERMEND_OATHWEAVE_CLIENT_SECRET: directoryConfig.clientSecret };

test('the grants mode stays the default and unchanged; the Oathweave mode is explicit and holds only service grants', async () => {
  const operatorGrant = { subject: operator.id, kind: 'operator', permissions: ['read'], scope };
  const serviceGrant = { subject: coordinator.id, kind: 'coordinator', permissions: ['read'], scope };
  for (const source of [undefined, '', 'grants']) {
    const config = authorityFromEnv({ EMBERMEND_AUTHORITY_SOURCE: source, EMBERMEND_IDENTITY_GRANTS: JSON.stringify([operatorGrant]), EMBERMEND_OATHWEAVE_ROLE_SCOPES: JSON.stringify(scopes) });
    assert.equal(config.source, 'grants'); assert.equal(config.roles, undefined); assert.deepEqual(config.grants(), [operatorGrant]);
    assert.equal((await config.storedAuthority(operator)).allowed, true);
    assert.throws(() => authorityFromEnv({ EMBERMEND_AUTHORITY_SOURCE: source }), /exactly one/);
  }
  assert.throws(() => authorityFromEnv({ EMBERMEND_AUTHORITY_SOURCE: 'roles', EMBERMEND_IDENTITY_GRANTS: '[]' }));
  const roles = authorityFromEnv(roleEnv, async () => null);
  assert.equal(roles.source, 'oathweave'); assert.deepEqual(roles.grants(), []); assert.deepEqual(roles.roles?.scopes(), scopes);
  assert.deepEqual(authorityFromEnv({ ...roleEnv, EMBERMEND_IDENTITY_GRANTS: JSON.stringify([serviceGrant]) }, async () => null).grants(), [serviceGrant]);
  assert.throws(() => authorityFromEnv({ ...roleEnv, EMBERMEND_IDENTITY_GRANTS: JSON.stringify([operatorGrant]) }), /OPERATOR_GRANTS_COME_FROM_OATHWEAVE_ROLES/);
  assert.throws(() => authorityFromEnv({ ...roleEnv, EMBERMEND_OATHWEAVE_ROLE_SCOPES: undefined }), /exactly one/);
  assert.throws(() => authorityFromEnv({ ...roleEnv, EMBERMEND_OATHWEAVE_CLIENT_SECRET: undefined }));
  assert.throws(() => authorityFromEnv({ ...roleEnv, EMBERMEND_OATHWEAVE_ROLE_SCOPES: JSON.stringify([...scopes, scopes[0]]) }), /mapped once/);
  // The real directory client is built from the settings when no lookup is given.
  assert.equal(typeof authorityFromEnv(roleEnv).roles?.lookup, 'function');
});

test('a role scopes file is reloaded on change and a bad version keeps the last valid mapping', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'embermend-role-scopes-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'role-scopes.json');
  const write = async (value: unknown) => { await writeFile(`${path}.tmp`, typeof value === 'string' ? value : JSON.stringify(value)); await rename(`${path}.tmp`, path); };
  await write(scopes.slice(0, 1));
  let clock = 0; const current = roleScopesFromEnv({ EMBERMEND_OATHWEAVE_ROLE_SCOPES_FILE: path }, { checkMs: 1000, now: () => clock });
  assert.equal(current().length, 1);
  await write(scopes); assert.equal(current().length, 1, 'checked at most once per interval'); clock += 1000; assert.equal(current().length, 3);
  const writes = t.mock.method(process.stderr, 'write', () => true);
  try { await write('{ not json'); clock += 1000; assert.equal(current().length, 3); } finally { writes.mock.restore(); }
  assert.ok(writes.mock.calls.some(call => String(call.arguments[0]).includes('role_scopes.reload_failed')));
  await write([]); clock += 1000; assert.deepEqual(current(), []);
});
