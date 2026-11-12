import { z } from 'zod';
import type { Model } from '../index.js';
import { responseJson } from '../index.js';
import { candidateJsonSchema, networkBaseUrl, type NetworkProvider } from './config.js';
export class NetworkInference implements Model {
  readonly ref: string; readonly local: boolean;
  constructor(private readonly config: NetworkProvider, private readonly env: NodeJS.ProcessEnv = process.env, private readonly request: typeof fetch = fetch) { this.ref = config.ref; this.local = config.kind === 'llamacpp'; }
  private headers(): Record<string, string> { const token = this.config.tokenEnv ? this.env[this.config.tokenEnv] : undefined; if (this.config.tokenEnv && !token) throw new Error('MODEL_CREDENTIAL_UNAVAILABLE'); return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }; }
  private url(path: string): URL { return new URL(path, networkBaseUrl(this.config).replace(/\/?$/, '/')); }
  async discover(signal: AbortSignal): Promise<void> {
    const response = await this.request(this.url('models'), { headers: this.headers(), redirect: 'error', signal }); if (!response.ok) throw new Error('MODEL_DISCOVERY_UNAVAILABLE');
    const models = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await responseJson(response));
    if (!models.data.some(value => value.id === this.config.model)) throw new Error('CONFIGURED_MODEL_NOT_LISTED');
  }
  async analyze(system: string, content: string, signal: AbortSignal): Promise<unknown> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]); await this.discover(bounded);
    const response = await this.request(this.url('chat/completions'), { method: 'POST', redirect: 'error', signal: bounded, headers: this.headers(), body: JSON.stringify({ model: this.config.model, temperature: 0, max_tokens: this.config.maxOutputTokens, response_format: { type: 'json_schema', json_schema: { name: 'security_candidates', strict: true, schema: candidateJsonSchema } }, messages: [{ role: 'system', content: system }, { role: 'user', content }] }) });
    if (!response.ok) throw new Error('MODEL_UNAVAILABLE');
    const result = z.object({ model: z.string(), choices: z.array(z.object({ finish_reason: z.literal('stop'), message: z.object({ content: z.string().max(1000000), tool_calls: z.undefined().optional() }) })).length(1) }).parse(await responseJson(response));
    if (result.model !== this.config.model) throw new Error('MODEL_IDENTITY_CHANGED');
    const choice = result.choices[0]; if (!choice) throw new Error('MODEL_COMPLETION_MISSING'); return JSON.parse(choice.message.content) as unknown;
  }
}
