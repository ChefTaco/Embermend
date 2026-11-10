import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { inferenceConfigSchema, inferenceRequestSchema, inferenceModel, candidateOutputSchema } from '@hivemagnus/embermend-integrations';
export function createInferenceBroker(raw: unknown, token: string, env: NodeJS.ProcessEnv = process.env, shutdown: AbortSignal = new AbortController().signal): Hono {
  if (token.length < 32) throw new Error('DEDICATED_INFERENCE_TOKEN_REQUIRED');
  const config = inferenceConfigSchema.parse(raw); const models = new Map(config.providers.map(provider => [provider.ref, { provider, model: inferenceModel(provider, env) }]));
  const expected = createHash('sha256').update(token).digest(); let active = 0;
  const app = new Hono(); app.get('/health/live', c => c.json({ status: 'alive', purpose: 'inference-only' }));
  app.use('/v1/*', bodyLimit({ maxSize: 256 * 1024 }));
  app.use('/v1/*', async (c, next) => { const received = c.req.header('authorization') ?? ''; const valid = received.startsWith('Bearer ') && timingSafeEqual(expected, createHash('sha256').update(received.slice(7)).digest()); if (!valid) return c.json({ error: 'UNAUTHORIZED' }, 401); await next(); });
  app.get('/v1/models', c => c.json({ object: 'list', data: [...models.values()].map(({ provider, model }) => ({ id: provider.ref, object: 'model', backend: provider.kind, model: provider.model, local: model.local })) }));
  app.post('/v1/chat/completions', async c => {
    const request = inferenceRequestSchema.parse(await c.req.json()); const selected = models.get(request.model);
    if (!selected || request.embermend_context.providerRef !== selected.provider.ref) return c.json({ error: 'PROVIDER_NOT_AUTHORIZED' }, 403);
    if (!selected.model.local && !request.embermend_context.allowRemoteModel) return c.json({ error: 'REMOTE_SOURCE_DISCLOSURE_DENIED' }, 403);
    if (active >= config.maxConcurrent) return c.json({ error: 'INFERENCE_CAPACITY_UNAVAILABLE' }, 429);
    active++;
    try {
      const [system, content] = request.messages;
      const result = candidateOutputSchema.parse(await selected.model.analyze(system.content, content.content, AbortSignal.any([shutdown, c.req.raw.signal, AbortSignal.timeout(selected.provider.timeoutMs)])));
      return c.json({ id: randomUUID(), model: selected.provider.ref, object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }] });
    } catch { return c.json({ error: 'INFERENCE_FAILED_INSPECT_PROVIDER_READINESS' }, 503); }
    finally { active--; }
  });
  app.onError((_error, c) => c.json({ error: 'INVALID_INFERENCE_REQUEST' }, 400)); return app;
}
