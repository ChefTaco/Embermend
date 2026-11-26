import { readFileSync, statSync } from 'node:fs';
import { grantsSchema } from '@hivemagnus/embermend-integrations';
import type { Grants } from './authority.js';
import { errorFields, logger } from './log.js';

/** The identity grants in force now. */
export type GrantSource = () => Grants;
/** How often a grants file is checked for a change. */
export const GRANTS_FILE_CHECK_MS = 2000;

const parse = (text: string): Grants => grantsSchema.parse(JSON.parse(text));

/**
 * Grants from `EMBERMEND_IDENTITY_GRANTS_FILE`, re-read when the file changes (checked at most
 * every two seconds, on use), so onboarding or revoking a subject needs no restart. The file must
 * be valid at startup. A later invalid version (for example one caught mid-write) is logged as
 * `grants.reload_failed` and the last valid grants stay in force until a valid file replaces it:
 * failing closed here would also fail every queued job of every subject for good. Write the file
 * atomically (write a temporary file, then rename it over the old one).
 */
export function fileGrants(path: string, options: { checkMs?: number; now?: () => number } = {}): GrantSource {
  const checkMs = options.checkMs ?? GRANTS_FILE_CHECK_MS; const now = options.now ?? Date.now;
  const version = (): string => { const stat = statSync(path); return `${stat.ino}:${stat.size}:${stat.mtimeMs}`; };
  let seen = version(); let grants = parse(readFileSync(path, 'utf8')); let checked = now();
  return () => {
    if (now() - checked < checkMs) return grants;
    checked = now();
    try {
      const current = version(); if (current === seen) return grants;
      const next = parse(readFileSync(path, 'utf8')); seen = current; grants = next;
      logger.info('grants.reloaded', { grants: next.length });
    } catch (error) {
      logger.error('grants.reload_failed', errorFields(error));
    }
    return grants;
  };
}

/** Grants from exactly one of `EMBERMEND_IDENTITY_GRANTS` (fixed) or `EMBERMEND_IDENTITY_GRANTS_FILE` (reloaded). */
export function grantsFromEnv(env: { EMBERMEND_IDENTITY_GRANTS?: string | undefined; EMBERMEND_IDENTITY_GRANTS_FILE?: string | undefined }): GrantSource {
  if (Boolean(env.EMBERMEND_IDENTITY_GRANTS) === Boolean(env.EMBERMEND_IDENTITY_GRANTS_FILE)) throw new Error('Configure exactly one of EMBERMEND_IDENTITY_GRANTS and EMBERMEND_IDENTITY_GRANTS_FILE');
  if (env.EMBERMEND_IDENTITY_GRANTS_FILE) return fileGrants(env.EMBERMEND_IDENTITY_GRANTS_FILE);
  const fixed = parse(env.EMBERMEND_IDENTITY_GRANTS ?? '');
  return () => fixed;
}
