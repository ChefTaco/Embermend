#!/usr/bin/node
// A fake CLI protocol peer. No external calls, credentials, or repository execution.
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-cli 1.0.0'); process.exit(0); }
const candidate = { candidates: [] };
const value = name => args[args.indexOf(name) + 1];
const ensure = condition => { if (!condition) process.exit(2); };
ensure(!process.env.MAGNUS_EMBERMEND_TOKEN && !process.env.EMBERMEND_GITHUB_TOKEN && !process.env.OPENAI_API_KEY);
if (args.includes('--print')) {
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) ensure(args.includes(flag));
  ensure(value('--tools') === '' && value('--setting-sources') === '' && value('--mcp-config') === '{"mcpServers":{}}');
  ensure(JSON.parse(value('--json-schema')).$schema === 'http://json-schema.org/draft-07/schema#');
  ensure(process.cwd() === process.env.HOME && process.env.CLAUDE_CONFIG_DIR !== process.env.HOME);
  let input = ''; for await (const part of process.stdin) input += part;
  const model = value('--model');
  if (model === 'fixture-wait') { writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'started'), String(process.pid)); setInterval(() => undefined, 1000); }
  else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: candidate, modelUsage: model === 'fixture-empty' ? {} : { [model === 'fixture-rerouted' ? 'other-model' : model]: {} }, permission_denials: model === 'fixture-tools' ? [{}] : [] }));
} else {
  ensure(args.includes('app-server'));
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line); if (id === undefined) return;
    if (method === 'initialize') send({ id, result: {} });
    if (method === 'config/read') {
      const features = {}; for (let i = 0; i < args.length; i++) if (args[i] === '--disable') features[args[i + 1]] = false;
      const disabled = args.includes('mcp_servers.fixture.enabled=false');
      send({ id, result: { config: { features, mcp_servers: { fixture: { enabled: !disabled } } } } });
    }
    if (method === 'account/read') send({ id, result: { account: { type: 'chatgpt' } } });
    if (method === 'model/list') send({ id, result: { data: ['fixture-model', 'fixture-tools', 'fixture-rerouted'].map(model => ({ model })) } });
    if (method === 'thread/start') {
      ensure(params.approvalPolicy === 'never' && params.sandbox === 'read-only' && params.ephemeral && process.cwd() === process.env.HOME);
      ensure(existsSync(join(process.env.CODEX_HOME, 'auth.json')));
      globalThis.selectedModel = params.model;
      send({ id, result: { thread: { id: 'fixture-thread', ephemeral: true }, model: params.model, approvalPolicy: 'never', sandbox: { type: 'readOnly' }, instructionSources: [] } });
    }
    if (method === 'turn/start') {
      send({ id, result: {} });
      if (globalThis.selectedModel === 'fixture-tools') send({ id: 'server-tool', method: 'item/tool/call', params: {} });
      else { if (globalThis.selectedModel === 'fixture-rerouted') send({ method: 'model/rerouted', params: {} });
        send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: JSON.stringify(candidate) } } });
        send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      }
    }
    if (method === 'thread/read') send({ id, result: { thread: { model: globalThis.selectedModel } } });
  });
}
