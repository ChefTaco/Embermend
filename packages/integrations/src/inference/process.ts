import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
export async function privateCredential(path: string): Promise<void> { const info = await lstat(path); if (!info.isFile() || info.nlink !== 1 || info.isSymbolicLink() || await realpath(path) !== path || info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error('PRIVATE_CLI_CREDENTIAL_REQUIRED'); }
export function cliEnvironment(home: string): NodeJS.ProcessEnv { return { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home, LANG: 'C.UTF-8', TERM: 'dumb', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }; }
export async function runBounded(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, input = ''): Promise<string> {
  signal.throwIfAborted(); const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const decoder = new StringDecoder('utf8'); let bytes = 0; let output = ''; let failed = false;
  const kill = (): void => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The group already exited. */ } } };
  const abort = (): void => { failed = true; kill(); };
  signal.addEventListener('abort', abort, { once: true });
  child.stdin.on('error', abort); child.stdout.on('data', (value: Buffer) => { bytes += value.length; if (bytes > 2 * 1024 * 1024) abort(); else output += decoder.write(value); });
  child.stderr.on('data', (value: Buffer) => { bytes += value.length; if (bytes > 2 * 1024 * 1024) abort(); });
  try { const result = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); child.stdin.end(input); const code = await result; if (failed || code !== 0 || signal.aborted) throw new Error('CLI_INFERENCE_FAILED_OR_CANCELED'); return output + decoder.end(); }
  finally { signal.removeEventListener('abort', abort); kill(); }
}
