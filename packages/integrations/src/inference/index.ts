import type { Model } from '../index.js';
import { inferenceProviderSchema } from './config.js';
import { NetworkInference } from './http.js';
import { CodexCliInference } from './codex.js';
import { ClaudeCliInference } from './claude.js';
export * from './config.js';
export { NetworkInference, CodexCliInference, ClaudeCliInference };
export function inferenceModel(raw: unknown, env: NodeJS.ProcessEnv = process.env): Model {
  const provider = inferenceProviderSchema.parse(raw);
  if (provider.kind === 'codex-cli') return new CodexCliInference(provider);
  if (provider.kind === 'claude-cli') return new ClaudeCliInference(provider);
  return new NetworkInference(provider, env);
}
