import { readScanSources } from './source-reader.js';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scanRequestSchema } from '@hivemagnus/embermend-contracts';
import { scan } from './index.js';
import type { Model } from '@hivemagnus/embermend-integrations';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const first = await lines.next(); if (first.done) throw new Error('Scanner request required');
const input = z.object({ request: scanRequestSchema, modelRef: z.string(), localModel: z.boolean() }).strict().parse(JSON.parse(first.value));
const { files, omitted } = await readScanSources('/source', input.request);
const model: Model = { ref: input.modelRef, local: input.localModel, analyze: async (system, content, signal) => {
  signal.throwIfAborted(); const id = randomUUID(); process.stdout.write(JSON.stringify({ kind: 'model-request', id, system, content }) + '\n');
  const line = await lines.next(); if (line.done) throw new Error('MODEL_BROKER_DISCONNECTED');
  const response = z.object({ id: z.string(), result: z.unknown() }).strict().parse(JSON.parse(line.value));
  if (response.id !== id) throw new Error('MODEL_BROKER_IDENTITY_MISMATCH'); return response.result;
} };
const stop = new AbortController(); process.once('SIGTERM', () => stop.abort());
const result = await scan(input.request, files, model, stop.signal);
result.coverage.excluded.push(...omitted);
result.coverage.requested.push(...omitted.filter(item => !['repository-metadata-or-installed-dependencies', 'outside-application-scope'].includes(item.reason)).map(item => item.path));
if (omitted.some(item => !['repository-metadata-or-installed-dependencies', 'outside-application-scope'].includes(item.reason))) { result.coverage.status = 'partial'; result.state = 'partial'; }
process.stdout.write(JSON.stringify({ kind: 'result', result }) + '\n');
process.exitCode = 0;
process.stdin.destroy();
