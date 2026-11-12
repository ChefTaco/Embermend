import { z } from 'zod';
import { createOathweaveVerifier, OATHWEAVE_NATIVE_ISSUER_PATTERN } from '@hivemagnus/hive-common/oathweave';
import type { Actor } from '@hivemagnus/embermend-contracts';
import type { grantsSchema } from '@hivemagnus/embermend-integrations';
import type { Authenticate } from './api.js';

/** Comma-separated `OATHWEAVE_NATIVE_ISSUERS`; empty when unset. Each is a lowercase identifier such as `hive-iam`. */
export function nativeIssuersFromEnv(value: string | undefined): string[] {
  const issuers = (value ?? '').split(',').map(entry => entry.trim()).filter(entry => entry.length > 0);
  for (const issuer of issuers) if (!OATHWEAVE_NATIVE_ISSUER_PATTERN.test(issuer)) throw new Error('OATHWEAVE_NATIVE_ISSUERS entries must be lowercase identifiers');
  return [...new Set(issuers)];
}

const payloadIssuer = (token: string): string | undefined => {
  const part = token.split('.')[1];
  if (!part || token.length > 16384) return undefined;
  try { const parsed = z.object({ iss: z.string() }).safeParse(JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))); return parsed.success ? parsed.data.iss : undefined; } catch { return undefined; }
};

/**
 * Oathweave signs client-credentials tokens with its native issuer unless the client's policy
 * selects the https issuer. A configured native issuer is accepted for service accounts only,
 * through the hive-common verifier, and such a token carries no permission but `audit:read`:
 * it can use the audit export and nothing else.
 */
export function withNativeIssuerServiceTokens(base: Authenticate, config: { issuer: string; jwksUrl: string; nativeIssuers: readonly string[]; grants: z.infer<typeof grantsSchema>; keys?: Parameters<typeof createOathweaveVerifier>[0]['keys'] }): Authenticate {
  if (config.nativeIssuers.length === 0) return base;
  const verifier = createOathweaveVerifier({ issuer: config.issuer, nativeIssuers: config.nativeIssuers, nativeIssuerAccept: 'service', accept: 'service', audience: 'embermend', jwksUrl: config.jwksUrl, ...(config.keys ? { keys: config.keys } : {}) });
  return async token => {
    const issuer = payloadIssuer(token);
    if (issuer === undefined || !config.nativeIssuers.includes(issuer)) return base(token);
    const principal = await verifier.verifyService(token);
    if (!config.nativeIssuers.includes(principal.issuer) || principal.clientId !== principal.subject) throw new Error('NATIVE_ISSUER_SERVICE_TOKEN_REQUIRED');
    const matching = config.grants.filter(grant => grant.subject === principal.clientId);
    const grant = matching.length === 1 ? matching[0] : undefined;
    if (!grant || grant.kind === 'operator') throw new Error('EXPLICIT_UNIQUE_SERVICE_GRANT_REQUIRED');
    const permissions: Actor['permissions'] = new Set(grant.permissions.includes('audit:read') && principal.permissions.includes('embermend:audit:read') ? ['audit:read'] : []);
    return { id: grant.subject, kind: grant.kind, scope: grant.scope, permissions };
  };
}
