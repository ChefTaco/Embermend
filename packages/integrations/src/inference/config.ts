import { z } from 'zod';
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/);
const common = { ref: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,100}$/), model: z.string().min(1).max(200), timeoutMs: z.number().int().min(1000).max(600000).default(120000) };
const network = { maxOutputTokens: z.number().int().min(256).max(32768).default(8192) };
const cli = { command: z.string().startsWith('/'), expectedVersion: z.string().min(1).max(200), credentialHome: z.string().startsWith('/') };
export const inferenceProviderSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, ...network, kind: z.literal('llamacpp'), baseUrl: z.url(), localNetworkApproved: z.literal(true), tokenEnv: envName.optional() }).strict(),
  z.object({ ...common, ...network, kind: z.literal('openai-compatible'), baseUrl: z.url(), tokenEnv: envName }).strict(),
  // An opt-in alias of openai-compatible for an Emberpath model router: `url` is the Emberpath root and
  // its OpenAI-compatible API is `<url>/v1`, authenticated with an Emberpath client API key.
  z.object({ ...common, ...network, kind: z.literal('emberpath'), ref: common.ref.default('emberpath'), url: z.url(), tokenEnv: envName.default('EMBERPATH_API_KEY') }).strict(),
  z.object({ ...common, ...cli, kind: z.literal('codex-cli'), effort: z.enum(['low', 'medium', 'high', 'xhigh']).default('medium') }).strict(),
  z.object({ ...common, ...cli, kind: z.literal('claude-cli') }).strict(),
]).superRefine((value, context) => {
  if (value.kind === 'emberpath') { const url = new URL(value.url); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) context.addIssue({ code: 'custom', message: 'Verified HTTPS Emberpath URL without credentials, query or fragment required' }); }
  if ('baseUrl' in value) { const url = new URL(value.baseUrl); if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || value.kind === 'llamacpp' && url.protocol === 'http:')) context.addIssue({ code: 'custom', message: 'Verified HTTPS or explicitly approved local llama.cpp network required' }); }
});
export type InferenceProvider = z.infer<typeof inferenceProviderSchema>;
export type NetworkProvider = Extract<InferenceProvider, { kind: 'llamacpp' | 'openai-compatible' | 'emberpath' }>;
/** The OpenAI-compatible base of a network provider; an Emberpath preset serves it at `<url>/v1`. */
export function networkBaseUrl(provider: NetworkProvider): string { return provider.kind === 'emberpath' ? `${trimTrailingSlashes(provider.url)}/v1` : provider.baseUrl; }
function trimTrailingSlashes(value: string): string { let end = value.length; while (end > 0 && value[end - 1] === '/') end--; return value.slice(0, end); }
export const inferenceConfigSchema = z.object({ providers: z.array(inferenceProviderSchema).min(1).max(16), maxConcurrent: z.number().int().min(1).max(8).default(1) }).strict().superRefine((value, context) => { if (new Set(value.providers.map(provider => provider.ref)).size !== value.providers.length) context.addIssue({ code: 'custom', message: 'Unique inference provider references required' }); });
export const inferenceRequestSchema = z.object({ model: z.string(), messages: z.tuple([z.object({ role: z.literal('system'), content: z.string().min(1).max(16000) }).strict(), z.object({ role: z.literal('user'), content: z.string().min(1).max(100000) }).strict()]), temperature: z.literal(0).optional(), response_format: z.object({ type: z.literal('json_object') }).strict(), embermend_context: z.object({ providerRef: z.string(), operationId: z.string().min(1).max(200), allowRemoteModel: z.boolean() }).strict() }).strict();
export const candidateOutputSchema = z.object({ candidates: z.array(z.object({ path: z.string().min(1).max(1000), line: z.number().int().positive(), symbol: z.string().min(1).max(1000), weakness: z.enum(['injection', 'path-handling', 'authorization', 'trust-boundary', 'secret', 'configuration']), title: z.string().max(1000), evidence: z.string().max(6000), assumptions: z.array(z.string().max(200)).max(100), severity: z.enum(['critical', 'high', 'medium', 'low', 'unknown']), confidence: z.number().min(0).max(1) }).strict()).max(100) }).strict();
export const candidateJsonSchema = z.toJSONSchema(candidateOutputSchema, { target: 'draft-7' });
