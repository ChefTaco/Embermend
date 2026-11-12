import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import type { Actor } from '@hivemagnus/embermend-contracts';
import { nativeIssuersFromEnv, withNativeIssuerServiceTokens } from '../services/runtime/src/native-issuer.js';
import { scope } from './fixtures.js';

test('native issuer settings are optional lowercase identifiers', () => {
  assert.deepEqual(nativeIssuersFromEnv(undefined), []);
  assert.deepEqual(nativeIssuersFromEnv(' fixture-iam, fixture-iam ,other-iam'), ['fixture-iam', 'other-iam']);
  assert.throws(() => nativeIssuersFromEnv('https://identity.example.com'));
});

test('a native-issuer service token is accepted for audit:read only, and never for a user', async () => {
  const pair = await generateKeyPair('RS256'); const publicKey = await exportJWK(pair.publicKey); publicKey.kid = 'fixture-key'; const keys = createLocalJWKSet({ keys: [publicKey] });
  const grants = [{ subject: 'fixture-collector', kind: 'integration' as const, permissions: ['audit:read' as const, 'read' as const], scope }, { subject: 'fixture-user', kind: 'operator' as const, permissions: ['audit:read' as const], scope }];
  const fallback: Actor = { id: 'fallback', kind: 'operator', permissions: new Set(), scope };
  let fallbackCalls = 0;
  const auth = withNativeIssuerServiceTokens(async () => { fallbackCalls++; return fallback; }, { issuer: 'https://identity.example.com', jwksUrl: 'https://identity.example.com/jwks', nativeIssuers: ['fixture-iam'], grants, keys });
  const sign = (issuer: string, subject: string, permissions: string[], extra: Record<string, unknown> = {}) => new SignJWT({ permissions, clientId: subject, actorType: 'SERVICE_ACCOUNT', token_type: 'access', ...extra }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer(issuer).setAudience('embermend').setSubject(subject).setJti('fixture-jti').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const actor = await auth(await sign('fixture-iam', 'fixture-collector', ['embermend:audit:read', 'embermend:read']));
  assert.equal(actor.kind, 'integration'); assert.deepEqual([...actor.permissions], ['audit:read']);
  assert.deepEqual([...(await auth(await sign('fixture-iam', 'fixture-collector', ['embermend:read']))).permissions], []);
  await assert.rejects(auth(await sign('fixture-iam', 'fixture-user', ['embermend:audit:read'])));
  await assert.rejects(auth(await sign('fixture-iam', 'fixture-user', ['embermend:audit:read'], { clientId: 'hivexui', actorType: 'USER', sessionId: 'fixture-session' })), /not accepted/);
  await assert.rejects(auth(await sign('fixture-iam', 'fixture-unknown', ['embermend:audit:read'])));
  assert.equal(fallbackCalls, 0);
  assert.equal(await auth(await sign('other-iam', 'fixture-collector', ['embermend:audit:read'])), fallback);
  assert.equal(await auth(await sign('https://identity.example.com', 'fixture-collector', ['embermend:audit:read'])), fallback);
  assert.equal(fallbackCalls, 2);
  const unset = withNativeIssuerServiceTokens(async () => fallback, { issuer: 'https://identity.example.com', jwksUrl: 'https://identity.example.com/jwks', nativeIssuers: [], grants, keys });
  assert.equal(await unset(await sign('fixture-iam', 'fixture-collector', ['embermend:audit:read'])), fallback);
});
