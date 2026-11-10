import { serve } from '@hono/node-server';
import { database } from '@hivemagnus/embermend-store';
import { Embermend } from '@hivemagnus/embermend-core';
import { MagnusClient, oathweaveAuthenticator, grantsSchema, GitHubClient } from '@hivemagnus/embermend-integrations';
import { z } from 'zod';
import { createApi } from './api.js';
import { runWorker } from './worker.js';
import { migrate, verifyMigrations } from './migrations.js';
import { VERSION } from '@hivemagnus/embermend-contracts';
export { createApi } from './api.js';
const githubGrants = z.array(z.object({ providerId: z.string(), owner: z.string(), name: z.string(), allowedBranches: z.array(z.string()), workflowIds: z.array(z.string()) }).strict());
const envSchema = z.object({ DATABASE_URL: z.url(), MAGNUS_URL: z.url(), MAGNUS_EMBERMEND_TOKEN: z.string().min(32), OATHWEAVE_ISSUER: z.url(), OATHWEAVE_JWKS_URL: z.url(), OATHWEAVE_USERINFO_URL: z.url(), EMBERMEND_IDENTITY_GRANTS: z.string(), EMBERMEND_GITHUB_TOKEN: z.string().min(1).optional(), EMBERMEND_GITHUB_GRANTS: z.string().optional(), EMBERMEND_BIND: z.string().default('127.0.0.1'), EMBERMEND_PORT: z.coerce.number().int().min(1).max(65535).default(4180) }).superRefine((env, context) => { if (Boolean(env.EMBERMEND_GITHUB_TOKEN) !== Boolean(env.EMBERMEND_GITHUB_GRANTS)) context.addIssue({ code: 'custom', message: 'GitHub token and exact repository grants must be configured together' }); });
if (process.argv[1]?.endsWith('/index.js')) {
  if (process.argv[2] === '--version') { console.log(VERSION); process.exit(0); }
  if (process.argv[2] === 'migrate' || process.argv[2] === 'verify-initialization') {
    const url = z.url().parse(process.env['DATABASE_URL']);
    if (process.argv[2] === 'migrate') await migrate(url); else await verifyMigrations(url);
    console.log('Exact Embermend migration history verified'); process.exit(0);
  }
  const env = envSchema.parse(process.env); const db = database(env.DATABASE_URL); const magnus = new MagnusClient(env.MAGNUS_URL, env.MAGNUS_EMBERMEND_TOKEN);
  const github = env.EMBERMEND_GITHUB_TOKEN && env.EMBERMEND_GITHUB_GRANTS ? new GitHubClient(env.EMBERMEND_GITHUB_TOKEN, githubGrants.parse(JSON.parse(env.EMBERMEND_GITHUB_GRANTS))) : undefined;
  const service = new Embermend(db, magnus, github);
  const authenticate = oathweaveAuthenticator({ issuer: env.OATHWEAVE_ISSUER, jwksUrl: env.OATHWEAVE_JWKS_URL, userinfoUrl: env.OATHWEAVE_USERINFO_URL, grants: grantsSchema.parse(JSON.parse(env.EMBERMEND_IDENTITY_GRANTS)) });
  const stop = new AbortController();
  if (process.argv[2] === 'worker') {
    process.once('SIGTERM', () => stop.abort()); process.once('SIGINT', () => stop.abort());
    await runWorker(service, stop.signal); await db.$disconnect();
  } else if (process.argv[2] === 'api') {
    const server = serve({ fetch: createApi(service, authenticate).fetch, hostname: env.EMBERMEND_BIND, port: env.EMBERMEND_PORT });
    const close = (): void => { server.close(() => { void db.$disconnect(); }); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
  } else throw new Error('Use api or worker');
}
