import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { Model } from '../index.js';
import { candidateJsonSchema, type InferenceProvider } from './config.js';
import { cliEnvironment, privateCredential, runBounded } from './process.js';
export class ClaudeCliInference implements Model {
  readonly local = false; readonly ref: string;
  constructor(private readonly config: Extract<InferenceProvider, { kind: 'claude-cli' }>) { this.ref = config.ref; }
  async analyze(system: string, content: string, signal: AbortSignal): Promise<unknown> {
    await privateCredential(join(this.config.credentialHome, '.credentials.json'));
    const cwd = await mkdtemp(join(tmpdir(), 'embermend-claude-')); const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
    const env = { ...cliEnvironment(cwd), CLAUDE_CONFIG_DIR: this.config.credentialHome, CLAUDE_CODE_SAFE_MODE: '1' };
    try {
      if ((await runBounded(this.config.command, ['--version'], cwd, env, bounded)).trim() !== this.config.expectedVersion) throw new Error('CLAUDE_VERSION_CHANGED');
      const output = await runBounded(this.config.command, ['--print', '--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--model', this.config.model, '--output-format', 'json', '--json-schema', JSON.stringify(candidateJsonSchema), '--system-prompt', system], cwd, env, bounded, content);
      const result = z.object({ type: z.literal('result'), subtype: z.literal('success'), is_error: z.literal(false), structured_output: z.unknown(), modelUsage: z.record(z.string(), z.unknown()), permission_denials: z.array(z.unknown()).max(0) }).parse(JSON.parse(output));
      if (!Object.keys(result.modelUsage).length || Object.keys(result.modelUsage).some(model => model !== this.config.model)) throw new Error('CLAUDE_MODEL_CHANGED');
      return result.structured_output;
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
}
