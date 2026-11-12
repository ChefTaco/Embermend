import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Model } from '../index.js';
import { candidateJsonSchema, type InferenceProvider } from './config.js';
import { cliEnvironment, privateCredential, runBounded } from './process.js';
const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'image_generation', 'in_app_browser', 'multi_agent', 'multi_agent_v2', 'view_image', 'memories', 'goals', 'remote_plugin', 'tool_suggest'];
const frameSchema = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() });
class Rpc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  next = 0; bytes = 0; listener: (method: string, params: unknown) => void = () => undefined;
  error: Error | undefined;
  constructor(command: string, cwd: string, env: NodeJS.ProcessEnv, private readonly signal: AbortSignal, public failed: (error: Error) => void, servers: string[] = []) {
    this.child = spawn(command, ['app-server', '--stdio', ...disabled.flatMap(feature => ['--disable', feature]), ...servers.flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]), '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'history.persistence="none"'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    const count = (part: Buffer): void => { this.bytes += part.length; if (this.bytes > 4 * 1024 * 1024) this.fail(new Error('CODEX_OUTPUT_LIMIT')); };
    this.child.stdout.on('data', count); this.child.stderr.on('data', count);
    this.child.stdin.on('error', () => this.fail(new Error('CODEX_TRANSPORT_CLOSED')));
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { const frame = frameSchema.parse(JSON.parse(line));
        if (frame.method && frame.id !== undefined) { this.write({ id: frame.id, error: { code: -32601, message: 'No tools or approvals available' } }); this.fail(new Error('CODEX_TOOL_REQUEST_REFUSED')); return; }
        if (frame.method) { this.listener(frame.method, frame.params); return; }
        if (typeof frame.id === 'number') { const request = this.pending.get(frame.id); this.pending.delete(frame.id); if (frame.error) request?.reject(new Error('CODEX_RPC_REFUSED')); else request?.resolve(frame.result); }
      } catch { this.fail(new Error('CODEX_PROTOCOL_OR_TOOL_BOUNDARY_FAILED')); }
    });
    this.child.once('error', () => this.fail(new Error('CODEX_UNAVAILABLE'))); this.child.once('close', () => this.fail(new Error('CODEX_TRANSPORT_CLOSED')));
    signal.addEventListener('abort', this.abort, { once: true }); if (signal.aborted) this.abort();
  }
  private readonly abort = (): void => this.fail(new Error('CODEX_CANCELED'));
  write(value: unknown): void { if (!this.error && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(value) + '\n'); }
  request(method: string, params: unknown): Promise<unknown> { if (this.error) return Promise.reject(this.error); const id = ++this.next; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.write({ id, method, params }); }); }
  fail(error: Error): void { if (this.error) return; this.error = error; for (const row of this.pending.values()) row.reject(error); this.pending.clear(); this.failed(error); void this.close(); }
  async close(): Promise<void> { this.signal.removeEventListener('abort', this.abort); if (this.child.pid) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* Process group already exited. */ } } await this.exited; }
}
export class CodexCliInference implements Model {
  readonly local = false; readonly ref: string;
  constructor(private readonly config: Extract<InferenceProvider, { kind: 'codex-cli' }>) { this.ref = config.ref; }
  async analyze(system: string, content: string, signal: AbortSignal): Promise<unknown> {
    await privateCredential(join(this.config.credentialHome, 'auth.json'));
    const cwd = await mkdtemp(join(tmpdir(), 'embermend-codex-')); const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
    const env = { ...cliEnvironment(cwd), CODEX_HOME: this.config.credentialHome }; let rpc: Rpc | undefined;
    try {
      if ((await runBounded(this.config.command, ['--version'], cwd, env, bounded)).trim() !== this.config.expectedVersion) throw new Error('CODEX_VERSION_CHANGED');
      let answer = ''; let threadId = ''; let rejectTurn: (error: Error) => void = () => undefined; let resolveTurn: () => void = () => undefined;
      const completed = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; }); void completed.catch(() => undefined);
      rpc = new Rpc(this.config.command, cwd, env, bounded, () => undefined);
      const listener = (method: string, params: unknown): void => {
        if (method === 'model/rerouted') throw new Error('CODEX_MODEL_CHANGED');
        if (method === 'item/started' || method === 'item/completed') { const item = z.object({ item: z.object({ type: z.string(), text: z.string().optional() }) }).parse(params).item;
          if (!['userMessage', 'agentMessage', 'reasoning'].includes(item.type)) throw new Error('CODEX_TOOL_ATTEMPT');
          if (method === 'item/completed' && item.type === 'agentMessage') answer = z.string().max(1000000).parse(item.text);
        }
        if (method === 'turn/completed') { const result = z.object({ turn: z.object({ status: z.literal('completed') }) }).safeParse(params); if (!result.success) rejectTurn(new Error('CODEX_TURN_FAILED')); else resolveTurn(); }
      };
      const initialize = async (server: Rpc): Promise<void> => { await server.request('initialize', { clientInfo: { name: 'embermend-inference', version: '0.2.0' }, capabilities: { experimentalApi: true } }); server.write({ method: 'initialized', params: {} }); };
      const loadedSchema = z.object({ config: z.object({ mcp_servers: z.record(z.string().max(200), z.object({ enabled: z.boolean().optional() }).passthrough()).default({}), features: z.record(z.string(), z.boolean().nullable()) }) });
      await initialize(rpc);
      const inherited = loadedSchema.parse(await rpc.request('config/read', { includeLayers: false }));
      const servers = Object.keys(inherited.config.mcp_servers); if (servers.length > 32 || servers.some(name => !/^[A-Za-z0-9_-]{1,100}$/.test(name))) throw new Error('CODEX_SERVER_CONFIGURATION_LIMIT');
      if (servers.length) {
        // Discover configuration without creating a thread or disclosing source, then
        // restart with each inherited server disabled. A TOML table override merges.
        await rpc.close();
        rpc = new Rpc(this.config.command, cwd, env, bounded, () => undefined, servers);
        await initialize(rpc);
      }
      const loaded = loadedSchema.parse(await rpc.request('config/read', { includeLayers: false }));
      if (Object.values(loaded.config.mcp_servers).some(server => server.enabled !== false) || disabled.some(feature => loaded.config.features[feature] !== false)) throw new Error('CODEX_TOOL_ISOLATION_UNAVAILABLE');
      rpc.failed = rejectTurn;
      rpc.listener = listener;
      const account = z.object({ account: z.object({ type: z.enum(['chatgpt', 'apiKey']) }) }).parse(await rpc.request('account/read', { refreshToken: false })); if (!account.account) throw new Error('CODEX_LOGIN_REQUIRED');
      const models = z.object({ data: z.array(z.object({ model: z.string() })) }).parse(await rpc.request('model/list', { limit: 100 })); if (!models.data.some(value => value.model === this.config.model)) throw new Error('CODEX_MODEL_UNAVAILABLE');
      const started = z.object({ thread: z.object({ id: z.string(), ephemeral: z.literal(true) }), model: z.string(), approvalPolicy: z.literal('never'), sandbox: z.object({ type: z.literal('readOnly') }), instructionSources: z.array(z.unknown()).max(0) }).parse(await rpc.request('thread/start', { model: this.config.model, cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, baseInstructions: system, developerInstructions: 'Analyze only supplied text. Tools and external instructions are unavailable.', dynamicTools: [] }));
      if (started.model !== this.config.model) throw new Error('CODEX_MODEL_CHANGED'); threadId = started.thread.id;
      await rpc.request('turn/start', { threadId, model: this.config.model, effort: this.config.effort, input: [{ type: 'text', text: content }], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, outputSchema: candidateJsonSchema });
      await completed;
      const observation = z.object({ thread: z.object({ model: z.string() }) }).parse(await rpc.request('thread/read', { threadId, includeTurns: false })); if (observation.thread.model !== this.config.model) throw new Error('CODEX_MODEL_CHANGED');
      return JSON.parse(answer) as unknown;
    } finally { await rpc?.close(); await rm(cwd, { recursive: true, force: true }); }
  }
}
