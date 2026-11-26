import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { grantsSchema, OathweaveDirectory, roleScopesSchema, type AccountLookup, type RoleScopes } from '@hivemagnus/embermend-integrations';
import { grantAuthority, oathweaveRoleAuthority, type Grants, type StoredAuthority } from './authority.js';
import { errorFields, logger } from './log.js';

/** The identity grants in force now. */
export type GrantSource = () => Grants;
/** How often a grants (or role scopes) file is checked for a change. */
export const GRANTS_FILE_CHECK_MS = 2000;

const parse = (text: string): Grants => grantsSchema.parse(JSON.parse(text));

/**
 * A JSON file re-read when it changes (checked at most every `checkMs`, on use). It must be valid
 * at startup. A later invalid version (for example one caught mid-write) is logged as
 * `<event>.reload_failed` and the last valid value stays in force until a valid file replaces it.
 */
function reloadingFile<T>(path: string, read: (text: string) => T, event: string, fields: (value: T) => Record<string, number>, options: { checkMs?: number; now?: () => number }): () => T {
  const checkMs = options.checkMs ?? GRANTS_FILE_CHECK_MS; const now = options.now ?? Date.now;
  const version = (): string => { const stat = statSync(path); return `${stat.ino}:${stat.size}:${stat.mtimeMs}`; };
  let seen = version(); let value = read(readFileSync(path, 'utf8')); let checked = now();
  return () => {
    if (now() - checked < checkMs) return value;
    checked = now();
    try {
      const current = version(); if (current === seen) return value;
      const next = read(readFileSync(path, 'utf8')); seen = current; value = next;
      logger.info(`${event}.reloaded`, fields(next));
    } catch (error) {
      logger.error(`${event}.reload_failed`, errorFields(error));
    }
    return value;
  };
}

/**
 * Grants from `EMBERMEND_IDENTITY_GRANTS_FILE`, re-read when the file changes (checked at most
 * every two seconds, on use), so onboarding or revoking a subject needs no restart. The file must
 * be valid at startup. A later invalid version (for example one caught mid-write) is logged as
 * `grants.reload_failed` and the last valid grants stay in force until a valid file replaces it:
 * failing closed here would also fail every queued job of every subject for good. Write the file
 * atomically (write a temporary file, then rename it over the old one).
 */
export function fileGrants(path: string, options: { checkMs?: number; now?: () => number; servicesOnly?: boolean } = {}): GrantSource {
  return reloadingFile(path, text => servicesOnly(parse(text), options.servicesOnly ?? false), 'grants', grants => ({ grants: grants.length }), options);
}

/** In Oathweave role mode operators come from Oathweave; a grants setting may hold only service grants. */
function servicesOnly(grants: Grants, required: boolean): Grants {
  if (required && grants.some(grant => grant.kind === 'operator')) throw new Error('OPERATOR_GRANTS_COME_FROM_OATHWEAVE_ROLES');
  return grants;
}

interface GrantEnv { EMBERMEND_IDENTITY_GRANTS?: string | undefined; EMBERMEND_IDENTITY_GRANTS_FILE?: string | undefined }

/** Grants from exactly one of `EMBERMEND_IDENTITY_GRANTS` (fixed) or `EMBERMEND_IDENTITY_GRANTS_FILE` (reloaded). */
export function grantsFromEnv(env: GrantEnv, options: { servicesOnly?: boolean; optional?: boolean } = {}): GrantSource {
  if (options.optional && !env.EMBERMEND_IDENTITY_GRANTS && !env.EMBERMEND_IDENTITY_GRANTS_FILE) return () => [];
  if (Boolean(env.EMBERMEND_IDENTITY_GRANTS) === Boolean(env.EMBERMEND_IDENTITY_GRANTS_FILE)) throw new Error('Configure exactly one of EMBERMEND_IDENTITY_GRANTS and EMBERMEND_IDENTITY_GRANTS_FILE');
  if (env.EMBERMEND_IDENTITY_GRANTS_FILE) return fileGrants(env.EMBERMEND_IDENTITY_GRANTS_FILE, { servicesOnly: options.servicesOnly ?? false });
  const fixed = servicesOnly(parse(env.EMBERMEND_IDENTITY_GRANTS ?? ''), options.servicesOnly ?? false);
  return () => fixed;
}

const roleEnvSchema = z.object({
  EMBERMEND_OATHWEAVE_ROLE_SCOPES: z.string().min(1).optional(),
  EMBERMEND_OATHWEAVE_ROLE_SCOPES_FILE: z.string().min(1).optional(),
  EMBERMEND_OATHWEAVE_API_URL: z.url(),
  EMBERMEND_OATHWEAVE_TOKEN_URL: z.url(),
  EMBERMEND_OATHWEAVE_CLIENT_ID: z.string().min(1),
  EMBERMEND_OATHWEAVE_CLIENT_SECRET: z.string().min(32),
  EMBERMEND_OATHWEAVE_DIRECTORY_CACHE_MS: z.coerce.number().int().min(0).max(60000).default(5000),
});
export type AuthorityEnv = GrantEnv & { EMBERMEND_AUTHORITY_SOURCE?: string | undefined } & Partial<Record<keyof z.infer<typeof roleEnvSchema>, string | undefined>>;

/** Where operator authority comes from, and the checks built from it. */
export interface AuthorityConfig {
  source: 'grants' | 'oathweave';
  /** Grants in force now: every grant in `grants` mode, service grants only in `oathweave` mode. */
  grants: GrantSource;
  /** Set in `oathweave` mode: operator authority from Oathweave roles. */
  roles?: { lookup: AccountLookup; scopes: () => RoleScopes };
  /** The worker's check of stored authority. */
  storedAuthority: StoredAuthority;
}

/** Role scopes from exactly one of `EMBERMEND_OATHWEAVE_ROLE_SCOPES` (fixed) or `EMBERMEND_OATHWEAVE_ROLE_SCOPES_FILE` (reloaded). */
export function roleScopesFromEnv(env: { EMBERMEND_OATHWEAVE_ROLE_SCOPES?: string | undefined; EMBERMEND_OATHWEAVE_ROLE_SCOPES_FILE?: string | undefined }, options: { checkMs?: number; now?: () => number } = {}): () => RoleScopes {
  if (Boolean(env.EMBERMEND_OATHWEAVE_ROLE_SCOPES) === Boolean(env.EMBERMEND_OATHWEAVE_ROLE_SCOPES_FILE)) throw new Error('Configure exactly one of EMBERMEND_OATHWEAVE_ROLE_SCOPES and EMBERMEND_OATHWEAVE_ROLE_SCOPES_FILE');
  const read = (text: string): RoleScopes => roleScopesSchema.parse(JSON.parse(text));
  if (env.EMBERMEND_OATHWEAVE_ROLE_SCOPES_FILE) return reloadingFile(env.EMBERMEND_OATHWEAVE_ROLE_SCOPES_FILE, read, 'role_scopes', scopes => ({ roles: scopes.length }), options);
  const fixed = read(env.EMBERMEND_OATHWEAVE_ROLE_SCOPES ?? '');
  return () => fixed;
}

/**
 * `EMBERMEND_AUTHORITY_SOURCE`: `grants` (the default, unchanged behaviour) takes every subject's
 * authority from the grants setting. `oathweave` takes operator authority from Oathweave roles
 * and the role scopes mapping; the grants setting becomes optional and may hold only coordinator
 * and integration grants.
 */
export function authorityFromEnv(env: AuthorityEnv, lookup?: AccountLookup): AuthorityConfig {
  const source = z.enum(['grants', 'oathweave']).default('grants').parse(env.EMBERMEND_AUTHORITY_SOURCE || undefined);
  if (source === 'grants') {
    const grants = grantsFromEnv(env);
    return { source, grants, storedAuthority: grantAuthority(grants) };
  }
  const settings = roleEnvSchema.parse(env);
  const scopes = roleScopesFromEnv(settings);
  const grants = grantsFromEnv(env, { servicesOnly: true, optional: true });
  const accounts = lookup ?? new OathweaveDirectory({ apiUrl: settings.EMBERMEND_OATHWEAVE_API_URL, tokenUrl: settings.EMBERMEND_OATHWEAVE_TOKEN_URL, clientId: settings.EMBERMEND_OATHWEAVE_CLIENT_ID, clientSecret: settings.EMBERMEND_OATHWEAVE_CLIENT_SECRET, cacheMs: settings.EMBERMEND_OATHWEAVE_DIRECTORY_CACHE_MS }).lookup;
  return { source, grants, roles: { lookup: accounts, scopes }, storedAuthority: oathweaveRoleAuthority(accounts, scopes, grants) };
}
