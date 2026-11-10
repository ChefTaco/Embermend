import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
const image = process.argv[2] ?? 'embermend-scanner:ci';
const root = await mkdtemp(join(tmpdir(), 'embermend-protocol-'));
const scope = { installationId: 'fixture', applicationIds: ['fixture-app'], targetIds: ['fixture-worker'] };
const common = { id: 'fixture-source', repositoryId: 'fixture-repository', providerId: 'fixture-provider', applicationId: 'fixture-app', scope, workerTargetId: 'fixture-worker', deadline: new Date(Date.now() + 180000).toISOString() };
const commit = 'a'.repeat(40); const path = 'apps/api/index.ts'; const content = 'export const fixture = 1;\n';
async function run(entry, payload, onFrame = () => undefined) {
  const name = 'embermend-protocol-' + randomUUID();
  const child = spawn('docker', ['run', '--rm', '--name', name, '--interactive', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=1g', '--cpus=1', '--mount', `type=bind,source=${root},target=/source`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--entrypoint=/usr/bin/node', image, '/app/packages/scanner/dist/' + entry + '.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  let stderr = ''; let size = 0; let terminal;
  child.stderr.on('data', part => { size += part.length; stderr += part; if (size > 65536) child.kill('SIGKILL'); });
  child.stdin.on('error', () => child.kill('SIGKILL'));
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  try {
    child.stdin.write(JSON.stringify(payload) + '\n');
    for await (const line of createInterface({ input: child.stdout })) {
      size += Buffer.byteLength(line); assert.ok(size < 8 * 1024 * 1024);
      const frame = JSON.parse(line); if (frame.kind === 'result') terminal = frame.result; else onFrame(frame, child.stdin);
    }
    assert.equal(await exit, 0, stderr); assert.ok(terminal); return terminal;
  } finally { clearTimeout(timer); child.stdin.destroy(); if (child.exitCode === null) { child.kill('SIGKILL'); await exit.catch(() => undefined); } try { execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' }); } catch { /* --rm may already have removed the container; verify independently. */ } const remaining = execFileSync('docker', ['ps', '--all', '--filter', `name=^${name}$`, '--format', '{{.ID}}'], { encoding: 'utf8' }); assert.equal(remaining.trim(), '', 'Container cleanup remains uncertain'); }
}
try {
  await mkdir(join(root, 'apps/api'), { recursive: true }); await chmod(root, 0o777); await chmod(join(root, 'apps'), 0o777); await chmod(join(root, 'apps/api'), 0o777); await writeFile(join(root, path), content, { mode: 0o666 });
  // Creation mode is filtered by the host umask. This disposable fixture must
  // remain writable by the image's unprivileged UID when it differs from CI's.
  await chmod(join(root, path), 0o666);
  const scanRequest = { repositoryId: common.repositoryId, providerId: common.providerId, applicationId: common.applicationId, scope, workerTargetId: common.workerTargetId, deadline: common.deadline, commit, branch: 'main', pullRequest: null, includedPaths: ['apps/api'], excludedPaths: [], profile: 'typescript-security.v1', mode: 'full', operationId: 'fixture-scan', cancellationId: 'fixture-cancel', maxFiles: 10, maxBytes: 10000, sourcePolicy: { providerRef: 'fixture-model', allowRemoteModel: false, allowRepositoryExecution: false } };
  const scanned = await run('cli', { request: scanRequest, modelRef: 'fixture-model', localModel: true }, (frame, stdin) => { assert.equal(frame.kind, 'model-request'); stdin.write(JSON.stringify({ id: frame.id, error: 'MODEL_BROKER_UNAVAILABLE' }) + '\n'); });
  assert.equal(scanned.state, 'partial'); assert.equal(scanned.coverage.status, 'partial'); assert.deepEqual(scanned.coverage.examined, []); assert.deepEqual(scanned.coverage.failures, ['analysis-failed:' + path]);
  const source = await run('source-cli', { request: { ...common, commit, paths: [path] } });
  assert.equal(source.files[0]?.content, content);
  const edited = 'export const fixture = 2;\n';
  const prepared = await run('preparation-cli', { request: { ...common, id: 'fixture-preparation', baseCommit: commit, branch: 'main', includedPaths: ['apps/api'], excludedPaths: [], edits: [{ path, beforeDigest: createHash('sha256').update(content).digest('hex'), content: edited }], validationProfileId: 'fixture-node', }, validationArgv: ['/usr/bin/node', '--input-type=module', '-e', 'console.log("fixture validation")'] });
  assert.equal(prepared.validated, true); assert.equal(await readFile(join(root, path), 'utf8'), edited);
  console.log('Scanner outage coverage, source reading and preparation passed inside the built isolated image.');
} finally { await rm(root, { recursive: true, force: true }); }
