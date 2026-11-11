import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Embermend } from '@hivemagnus/embermend-core';
import { database } from '@hivemagnus/embermend-store';
import { MagnusClient } from '@hivemagnus/embermend-integrations';
import { createApi } from '../services/runtime/src/api.js';
import { operator } from './fixtures.js';

function chunkedBody(size: number, chunkSize = 1): ReadableStream<Uint8Array> {
  let remaining = size;
  return new ReadableStream({
    pull(controller) {
      if (remaining === 0) return controller.close();
      const length = Math.min(chunkSize, remaining);
      remaining -= length;
      controller.enqueue(new Uint8Array(length).fill(120));
    },
  });
}

test('API body limit coalesces tiny chunks and rejects oversize streams before authentication', async t => {
  const db = database('postgresql://fixture:fixture@127.0.0.1:1/embermend_test_body_limit');
  t.after(async () => db.$disconnect());
  const service = new Embermend(db, new MagnusClient('https://magnus.example.com', 'fixture-magnus-token-not-real-000000'));
  let authentications = 0;
  const app = createApi(service, async () => { authentications++; return operator; });
  app.post('/body-limit-fixture', async c => {
    const reader = c.req.raw.body?.getReader();
    assert.ok(reader);
    let chunks = 0;
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks++;
      bytes += next.value.length;
      assert.ok(next.value.every(byte => byte === 120));
    }
    return c.json({ chunks, bytes });
  });
  const withinLimit: RequestInit & { duplex: 'half' } = {
    method: 'POST', body: chunkedBody(65536), duplex: 'half',
  };
  const accepted = await app.request('/body-limit-fixture', withinLimit);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { chunks: 1, bytes: 65536 });

  const overLimit: RequestInit & { duplex: 'half' } = {
    method: 'POST', body: chunkedBody(2 * 1024 * 1024 + 1, 4096), duplex: 'half',
  };
  const rejected = await app.request('/api/v1/entities', overLimit);
  assert.equal(rejected.status, 413);
  assert.deepEqual(await rejected.json(), { error: 'REQUEST_TOO_LARGE' });
  assert.equal(authentications, 0);
});
