import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { capabilitySchema, operationRequestSchema, receiptSchema, permissions, scopeSchema, jsonObject, type Actor, type OperationRequest, type Receipt } from '@hivemagnus/embermend-contracts';

export class IntegrationError extends Error { constructor(public readonly code: string, public readonly uncertain: boolean) { super(code); } }
export function endpoint(value: string, allowLoopback = false): URL {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash)
    throw new Error('Verified HTTPS endpoint required');
  return url;
}
export async function responseJson(response: Response): Promise<unknown> {
  const max = 8 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > max) throw new Error('RESPONSE_TOO_LARGE');
  if (!response.body) throw new Error('EMPTY_RESPONSE');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > max) throw new Error('RESPONSE_TOO_LARGE'); chunks.push(part.value); }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export interface Magnus {
  capabilities(signal?: AbortSignal): Promise<z.infer<typeof capabilitySchema>>;
  dispatch(request: OperationRequest, signal?: AbortSignal): Promise<Receipt>;
  receipt(operationId: string, signal?: AbortSignal): Promise<Receipt>;
}
export class MagnusClient implements Magnus {
  private readonly base: URL;
  constructor(base: string, private readonly token: string, private readonly request: typeof fetch = fetch, allowLoopback = false) { this.base = endpoint(base, allowLoopback); }
  private async call(path: string, method: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      const response = await this.request(new URL(path, this.base), { method, redirect: 'error', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, signal: signal ?? AbortSignal.timeout(30000), ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      if (!response.ok) throw new IntegrationError(`MAGNUS_HTTP_${response.status}`, method !== 'GET' && response.status >= 500);
      return await responseJson(response);
    } catch (error) { if (error instanceof IntegrationError) throw error; throw new IntegrationError('MAGNUS_COMMUNICATION_OR_SCHEMA_FAILURE', method !== 'GET'); }
  }
  async capabilities(signal?: AbortSignal) { return capabilitySchema.parse(await this.call('/api/v1/embermend/capabilities', 'GET', undefined, signal)); }
  async dispatch(request: OperationRequest, signal?: AbortSignal) { try { return receiptSchema.parse(await this.call('/api/v1/embermend/operations', 'POST', operationRequestSchema.parse(request), signal)); } catch (error) { if (error instanceof IntegrationError) throw error; throw new IntegrationError('MAGNUS_INVALID_DISPATCH_RECEIPT', true); } }
  async receipt(operationId: string, signal?: AbortSignal) { return receiptSchema.parse(await this.call(`/api/v1/embermend/operations/${encodeURIComponent(operationId)}`, 'GET', undefined, signal)); }
}
const grantSchema = z.object({ subject: z.string(), kind: z.enum(['operator', 'coordinator', 'integration']), permissions: z.array(z.enum(permissions)), scope: scopeSchema }).strict();
export const grantsSchema = z.array(grantSchema);
const tokenClaims = z.object({ sub: z.string(), permissions: z.array(z.string()) });
export function oathweaveAuthenticator(config: { issuer: string; jwksUrl: string; userinfoUrl: string; grants: z.infer<typeof grantsSchema> }, overrides: { keys?: JWTVerifyGetKey; request?: typeof fetch } = {}): (token: string) => Promise<Actor> {
  endpoint(config.issuer); endpoint(config.jwksUrl); endpoint(config.userinfoUrl);
  const keys = overrides.keys ?? createRemoteJWKSet(new URL(config.jwksUrl)); const request = overrides.request ?? fetch;
  return async token => {
    const verified = await jwtVerify(token, keys, { issuer: config.issuer, audience: 'embermend', algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp', 'jti'], maxTokenAge: '15m' });
    if (verified.payload.aud !== 'embermend' || typeof verified.payload.iat !== 'number' || typeof verified.payload.exp !== 'number' || verified.payload.exp <= verified.payload.iat || verified.payload.exp - verified.payload.iat > 900) throw new Error('INVALID_RESOURCE_TOKEN_LIFETIME_OR_AUDIENCE');
    const claims = tokenClaims.parse(verified.payload);
    const matching = config.grants.filter(grant => grant.subject === claims.sub);
    if (matching.length !== 1) throw new Error('EXPLICIT_UNIQUE_PRODUCT_GRANT_REQUIRED');
    const grant = matching[0]; if (!grant) throw new Error('PRODUCT_GRANT_REQUIRED');
    if (grant.kind === 'operator') {
      z.object({ actorType: z.literal('USER'), sessionId: z.string().min(1), clientId: z.string().min(1), roles: z.array(z.string()) }).parse(verified.payload);
      const response = await request(config.userinfoUrl, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('IDENTITY_REVOKED_OR_UNAVAILABLE');
      const identity = z.object({ sub: z.string() }).parse(await responseJson(response));
      if (identity.sub !== grant.subject) throw new Error('IDENTITY_SUBJECT_MISMATCH');
    } else {
      const identity = z.object({ actorType: z.literal('SERVICE_ACCOUNT'), token_type: z.literal('access'), clientId: z.literal(grant.subject), sessionId: z.undefined().optional() }).parse(verified.payload);
      if (identity.clientId !== claims.sub) throw new Error('SERVICE_SUBJECT_MISMATCH');
    }
    const allowed = grant.permissions.filter(permission => claims.permissions.includes(`embermend:${permission}`));
    if (grant.kind !== 'operator' && allowed.some(permission => ['approve', 'policy', 'exception', 'recover'].includes(permission))) throw new Error('NON_OPERATOR_AUTHORITY_ESCALATION');
    if (grant.kind === 'coordinator' && allowed.includes('ingest')) throw new Error('COORDINATOR_CANNOT_VALIDATE_ITS_OWN_EVIDENCE');
    return { id: grant.subject, kind: grant.kind, scope: grant.scope, permissions: new Set(allowed) };
  };
}
export class ResourceTokenProvider {
  private cached: { token: string; expiresAt: number } | undefined;
  private pending: Promise<string> | undefined;
  constructor(private readonly config: { tokenUrl: string; clientId: string; clientSecret: string; scope: string }, private readonly request: typeof fetch = fetch) { endpoint(config.tokenUrl); }
  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 30000) return this.cached.token;
    if (this.pending) return this.pending;
    this.pending = this.refresh().finally(() => { this.pending = undefined; }); return this.pending;
  }
  private async refresh(): Promise<string> {
    const response = await this.request(this.config.tokenUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.config.clientId, client_secret: this.config.clientSecret, scope: this.config.scope }) });
    if (!response.ok) throw new Error('SCOPED_SERVICE_TOKEN_UNAVAILABLE');
    const value = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().max(900), token_type: z.string().regex(/^bearer$/i) }).parse(await responseJson(response));
    this.cached = { token: value.access_token, expiresAt: Date.now() + value.expires_in * 1000 }; return value.access_token;
  }
}
export function redact(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, value => '[REDACTED PRIVATE KEY]' + '\n'.repeat(value.split('\n').length - 1))
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED CREDENTIAL]')
    .replace(/(authorization["']?\s*[=:]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s"',;}]+/gi, '$1[REDACTED]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key)["']?\s*[=:]\s*["']?)([^\s"',;}]{4,})/gi, '$1[REDACTED]');
}
export function redactObject(value: unknown): z.infer<typeof jsonObject> {
  const sanitize = (input: z.infer<ReturnType<typeof z.json>>): z.infer<ReturnType<typeof z.json>> => {
    if (typeof input === 'string') return redact(input);
    if (Array.isArray(input)) return input.map(sanitize);
    if (input === null || typeof input !== 'object') return input;
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, /(?:password|passwd|secret|token|apikey|authorization|privatekey|signingkey|encryptionkey)$/i.test(key.replace(/[^a-z0-9]/gi, '')) ? '[REDACTED]' : sanitize(item)]));
  };
  return jsonObject.parse(sanitize(jsonObject.parse(value)));
}
export const textDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface Model { ref: string; local: boolean; analyze(system: string, content: string, signal: AbortSignal): Promise<unknown> }
export class OpenAICompatibleModel implements Model {
  private readonly url: URL;
  constructor(base: string, private readonly model: string, private readonly token: string, public readonly ref: string, public readonly local: boolean, allowLoopback = false) { this.url = endpoint(base, allowLoopback); }
  async analyze(system: string, content: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(new URL('chat/completions', this.url.href.endsWith('/') ? this.url : new URL(this.url.href + '/')), { method: 'POST', redirect: 'error', signal, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content }], response_format: { type: 'json_object' } }) });
    if (!response.ok) throw new Error('MODEL_UNAVAILABLE');
    const result = z.object({ choices: z.array(z.object({ finish_reason: z.string(), message: z.object({ content: z.string() }) })).min(1) }).parse(await responseJson(response));
    const choice = result.choices[0]; if (!choice || choice.finish_reason !== 'stop') throw new Error('MODEL_ANALYSIS_TRUNCATED');
    return JSON.parse(choice.message.content) as unknown;
  }
}
export { GitHubClient, type GitHubRepositoryGrant } from './github.js';

export * from './threat-feeds.js';
