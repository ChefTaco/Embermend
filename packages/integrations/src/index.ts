import { createHash } from 'node:crypto';
import type { JWTVerifyGetKey } from 'jose';
import { createOathweaveVerifier, createServiceTokenProvider, isOathweaveError, statusForReason, type ServiceTokenProvider } from '@hivemagnus/hive-common/oathweave';
import { z } from 'zod';
import { capabilitySchema, operationRequestSchema, receiptSchema, permissions, scopeSchema, jsonObject, type Actor, type OperationRequest, type Receipt } from '@hivemagnus/embermend-contracts';

export class IntegrationError extends Error { constructor(public readonly code: string, public readonly uncertain: boolean) { super(code); } }
export function endpoint(value: string, allowLoopback = false): URL {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash)
    throw new Error('Verified HTTPS endpoint required');
  return url;
}
/** `value` without trailing `/` characters, in linear time. */
export function withoutTrailingSlashes(value: string): string {
  let end = value.length; while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
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
      // Join under the configured base path (`https://host/magnus` + `/api/v1/...`), as `endpoint()` allows one.
      const target = new URL(this.base); target.pathname = withoutTrailingSlashes(this.base.pathname) + path;
      const response = await this.request(target, { method, redirect: 'error', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, signal: signal ?? AbortSignal.timeout(30000), ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
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
/**
 * Oathweave resource-token authentication with the shared hive-common verifier: RS256 only,
 * audience `embermend`, issuer, lifetime (at most 900 s) and `jti` checks, and an online userinfo
 * check of every user token. Product authority comes only from the unique matching grant.
 *
 * Refusals are `OathweaveError`s (401) or plain errors naming the grant problem. An identity
 * provider that cannot be reached, or answers 5xx, is an `OathweaveError` whose reason is
 * `jwks_unavailable` or `identity_unavailable` (503): verification could not run, so the caller
 * should retry rather than sign out. A userinfo 401 or 403 is a revoked session (401).
 */
export function oathweaveAuthenticator(config: { issuer: string; jwksUrl: string; userinfoUrl: string; grants: z.infer<typeof grantsSchema> | (() => z.infer<typeof grantsSchema>) }, overrides: { keys?: JWTVerifyGetKey; request?: typeof fetch } = {}): (token: string) => Promise<Actor> {
  endpoint(config.issuer); endpoint(config.jwksUrl); endpoint(config.userinfoUrl);
  const verifier = createOathweaveVerifier({ issuer: config.issuer, audience: 'embermend', jwksUrl: config.jwksUrl, userinfoUrl: config.userinfoUrl, accept: 'any', clientIdClaim: 'clientId', sessionCacheTtlMs: 0, clockToleranceSec: 0, ...(overrides.keys ? { keys: overrides.keys } : {}), ...(overrides.request ? { fetch: overrides.request } : {}) });
  // A function is read on every request, so grants can change without a restart.
  const source = config.grants; const grants = typeof source === 'function' ? source : (): z.infer<typeof grantsSchema> => source;
  return async token => {
    const principal = await verifier.verify(token);
    const matching = grants().filter(grant => grant.subject === principal.subject);
    if (matching.length !== 1) throw new Error('EXPLICIT_UNIQUE_PRODUCT_GRANT_REQUIRED');
    const grant = matching[0]; if (!grant) throw new Error('PRODUCT_GRANT_REQUIRED');
    if (grant.kind === 'operator') {
      // A user token, its session checked online by the verifier; Oathweave always sends roles.
      if (principal.kind !== 'user' || !Array.isArray(principal.claims['roles'])) throw new Error('OPERATOR_USER_TOKEN_REQUIRED');
    } else if (principal.kind !== 'service' || principal.clientId !== grant.subject) throw new Error('SERVICE_SUBJECT_MISMATCH');
    const allowed = grant.permissions.filter(permission => principal.permissions.includes(`embermend:${permission}`));
    if (grant.kind !== 'operator' && allowed.some(permission => ['approve', 'policy', 'exception', 'recover'].includes(permission))) throw new Error('NON_OPERATOR_AUTHORITY_ESCALATION');
    if (grant.kind === 'coordinator' && allowed.includes('ingest')) throw new Error('COORDINATOR_CANNOT_VALIDATE_ITS_OWN_EVIDENCE');
    return { id: grant.subject, kind: grant.kind, scope: grant.scope, permissions: new Set(allowed) };
  };
}
/** True when authentication could not run because the identity provider is unavailable. */
export function identityProviderUnavailable(error: unknown): boolean {
  return isOathweaveError(error) && statusForReason(error.reason) === 503;
}
/**
 * A cached client-credentials token for one scoped resource, on the hive-common provider:
 * concurrent callers share one request, a failure backs off briefly, and a token is cached for
 * at most 15 minutes, the longest lifetime Embermend accepts.
 */
export class ResourceTokenProvider {
  private readonly provider: ServiceTokenProvider;
  constructor(config: { tokenUrl: string; clientId: string; clientSecret: string; scope: string }, request: typeof fetch = fetch) {
    endpoint(config.tokenUrl);
    this.provider = createServiceTokenProvider({ tokenUrl: config.tokenUrl, clientId: config.clientId, clientSecret: config.clientSecret, scope: config.scope, fetch: request, maxLifetimeMs: 900000 });
  }
  async token(): Promise<string> { return this.provider.token(); }
  /** Forget the cached token, for example after the resource answered 401. */
  invalidate(): void { this.provider.invalidate(); }
}
/** The end of a `-----BEGIN|END <label>PRIVATE KEY-----` marker at `at`, where the label holds no `-`; -1 when there is none. */
function pemMarkerEnd(text: string, at: number, prefix: string): number {
  const label = at + prefix.length; const dash = text.indexOf('-', label);
  return dash - label >= 11 && text.startsWith('PRIVATE KEY-----', dash - 11) ? dash + 5 : -1;
}
/**
 * Replace each private-key block with a placeholder that keeps its line count. A linear scan with the same matches as
 * /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, which is quadratic on repeated BEGIN markers.
 */
function redactPrivateKeyBlocks(text: string): string {
  const begin = '-----BEGIN ', end = '-----END '; let output = '', copied = 0;
  for (let at = text.indexOf(begin); at !== -1; at = text.indexOf(begin, at + 1)) {
    const header = pemMarkerEnd(text, at, begin); if (header === -1) continue;
    let footer = -1;
    for (let close = text.indexOf(end, header); close !== -1 && footer === -1; close = text.indexOf(end, close + 1)) footer = pemMarkerEnd(text, close, end);
    // No closing marker follows this one, so none follows any later opening marker either.
    if (footer === -1) break;
    const block = text.slice(at, footer); output += text.slice(copied, at) + '[REDACTED PRIVATE KEY]' + '\n'.repeat(block.split('\n').length - 1);
    copied = footer; at = footer - 1;
  }
  return output + text.slice(copied);
}
export function redact(text: string): string {
  return redactPrivateKeyBlocks(text)
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
export { GitHubClient, githubMergeOperationSchema, type GitHubRepositoryGrant, type GitHubMergeOperation } from './github.js';

export * from './threat-feeds.js';
export * from './inference/index.js';
export * from './registry.js';
