import { readFile } from 'node:fs/promises';
import { createInferenceBroker } from './inference.js';
import { serve } from '@hono/node-server';
import { database } from '@hivemagnus/embermend-store';
import { Embermend } from '@hivemagnus/embermend-core';
import { nativeIssuersFromEnv, withNativeIssuerServiceTokens } from './native-issuer.js';
import { MagnusClient, oathweaveAuthenticator, GitHubClient, OciRegistryPublisher } from '@hivemagnus/embermend-integrations';
import { authorityFromEnv } from './grants.js';
import { z } from 'zod';
import { createApi } from './api.js';
import { MAX_WORKER_CONCURRENCY, runWorker } from './worker.js';
import { logger } from './log.js';
import { migrate, verifyMigrations } from './migrations.js';
import { VERSION } from '@hivemagnus/embermend-contracts';
export { createApi } from './api.js';
const githubGrants = z.array(z.object({ providerId: z.string(), owner: z.string(), name: z.string(), allowedBranches: z.array(z.string()), workflowIds: z.array(z.string()) }).strict());
const envSchema = z.object({ DATABASE_URL: z.url(), MAGNUS_URL: z.url(), MAGNUS_EMBERMEND_TOKEN: z.string().min(32), OATHWEAVE_ISSUER: z.url(), OATHWEAVE_JWKS_URL: z.url(), OATHWEAVE_USERINFO_URL: z.url(), EMBERMEND_IDENTITY_GRANTS: z.string().optional(), EMBERMEND_IDENTITY_GRANTS_FILE: z.string().min(1).optional(), EMBERMEND_GITHUB_TOKEN: z.string().min(1).optional(), EMBERMEND_GITHUB_GRANTS: z.string().optional(), EMBERMEND_BIND: z.string().default('127.0.0.1'), EMBERMEND_PORT: z.coerce.number().int().min(1).max(65535).default(4180) }).superRefine((env, context) => { if (Boolean(env.EMBERMEND_GITHUB_TOKEN) !== Boolean(env.EMBERMEND_GITHUB_GRANTS)) context.addIssue({ code: 'custom', message: 'GitHub token and exact repository grants must be configured together' }); });
// Docker and Compose send SIGKILL 10 seconds after SIGTERM unless stop_grace_period is longer.
const workerSettings = z.object({ EMBERMEND_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(MAX_WORKER_CONCURRENCY).default(1), EMBERMEND_WORKER_DRAIN_SECONDS: z.coerce.number().int().min(0).max(3600).default(8) });
if (process.argv[1]?.endsWith('/index.js')) {
  if (process.argv[2] === 'inference') {
    const settings = z.object({ EMBERMEND_INFERENCE_CONFIG: z.string().min(1), EMBERMEND_INFERENCE_TOKEN: z.string().min(32), EMBERMEND_INFERENCE_BIND: z.literal('127.0.0.1').default('127.0.0.1'), EMBERMEND_INFERENCE_PORT: z.coerce.number().int().min(1).max(65535).default(4181) }).parse(process.env);
    const shutdown = new AbortController();
    const server = serve({ fetch: createInferenceBroker(JSON.parse(await readFile(settings.EMBERMEND_INFERENCE_CONFIG, 'utf8')), settings.EMBERMEND_INFERENCE_TOKEN, process.env, shutdown.signal).fetch, hostname: settings.EMBERMEND_INFERENCE_BIND, port: settings.EMBERMEND_INFERENCE_PORT });
    const close = (): void => { shutdown.abort(); server.close(); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
  } else {
    if (process.argv[2] === '--version') { console.log(VERSION); process.exit(0); }
    if (process.argv[2] === 'migrate' || process.argv[2] === 'verify-initialization') {
      const url = z.url().parse(process.env['DATABASE_URL']);
      if (process.argv[2] === 'migrate') await migrate(url); else await verifyMigrations(url);
      console.log('Exact Embermend migration history verified'); process.exit(0);
    }
    const env = envSchema.parse(process.env); const db = database(env.DATABASE_URL); const magnus = new MagnusClient(env.MAGNUS_URL, env.MAGNUS_EMBERMEND_TOKEN);
    const github = env.EMBERMEND_GITHUB_TOKEN && env.EMBERMEND_GITHUB_GRANTS ? new GitHubClient(env.EMBERMEND_GITHUB_TOKEN, githubGrants.parse(JSON.parse(env.EMBERMEND_GITHUB_GRANTS))) : undefined;
    const publicationConfig = z.string().min(1).optional().parse(process.env['EMBERMEND_PUBLICATION_CONFIG']);
    const publisher = publicationConfig ? new OciRegistryPublisher(JSON.parse(await readFile(publicationConfig, 'utf8')), process.env) : undefined;
    const service = new Embermend(db, magnus, github, publisher);
    // EMBERMEND_AUTHORITY_SOURCE: `grants` (default) or `oathweave` (operators from Oathweave roles).
    const authority = authorityFromEnv(process.env); const grants = authority.grants;
    logger.info('authority.source', { source: authority.source });
    const authenticate = withNativeIssuerServiceTokens(oathweaveAuthenticator({ issuer: env.OATHWEAVE_ISSUER, jwksUrl: env.OATHWEAVE_JWKS_URL, userinfoUrl: env.OATHWEAVE_USERINFO_URL, grants, ...(authority.roles ? { roles: authority.roles } : {}) }), { issuer: env.OATHWEAVE_ISSUER, jwksUrl: env.OATHWEAVE_JWKS_URL, nativeIssuers: nativeIssuersFromEnv(process.env['OATHWEAVE_NATIVE_ISSUERS']), grants });
    const stop = new AbortController();
    if (process.argv[2] === 'worker') {
      const settings = workerSettings.parse(process.env);
      // The first SIGTERM stops claiming and lets running jobs finish their current receipt or
      // verification for up to EMBERMEND_WORKER_DRAIN_SECONDS; a second signal aborts at once.
      const abort = new AbortController();
      const shutdown = (): void => {
        if (stop.signal.aborted) { abort.abort(); return; }
        stop.abort(); logger.info('worker.draining', { drainSeconds: settings.EMBERMEND_WORKER_DRAIN_SECONDS });
        setTimeout(() => abort.abort(), settings.EMBERMEND_WORKER_DRAIN_SECONDS * 1000).unref();
      };
      process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
      await runWorker(service, stop.signal, authority.storedAuthority, { abort: abort.signal, concurrency: settings.EMBERMEND_WORKER_CONCURRENCY }); await db.$disconnect();
    } else if (process.argv[2] === 'api') {
      const server = serve({ fetch: createApi(service, authenticate, { auditActorKind: actorId => grants().find(grant => grant.subject === actorId)?.kind }).fetch, hostname: env.EMBERMEND_BIND, port: env.EMBERMEND_PORT });
      const close = (): void => { server.close(() => { void db.$disconnect(); }); };
      process.once('SIGTERM', close); process.once('SIGINT', close);
    } else throw new Error('Use api or worker');
  }

}
