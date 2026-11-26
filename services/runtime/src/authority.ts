import type { z } from 'zod';
import type { Actor, Permission } from '@hivemagnus/embermend-contracts';
import type { grantsSchema } from '@hivemagnus/embermend-integrations';
import { within } from '@hivemagnus/embermend-store';

/**
 * Jobs and schedules store the actor that created them. Before the worker acts on one,
 * that stored authority is checked against the identity grants in force now:
 * - no unique grant for the subject, a changed actor kind, or a stored scope the grant no
 *   longer covers revokes it (the job fails, the delivery is blocked);
 * - permissions are intersected with the grant, so a job continues only if it still has
 *   the permission its normal admission requires.
 */
export type Grants = z.infer<typeof grantsSchema>;
export type AuthorityDecision =
  | { allowed: true; actor: Actor; removed: Permission[] }
  | { allowed: false; reason: 'ACTOR_GRANT_REVOKED' | 'ACTOR_KIND_CHANGED' | 'ACTOR_SCOPE_REVOKED' };
export type StoredAuthority = (stored: Actor) => AuthorityDecision;

export const REVOKED_AUTHORITY_CODES: readonly string[] = ['ACTOR_GRANT_REVOKED', 'ACTOR_KIND_CHANGED', 'ACTOR_SCOPE_REVOKED'];

export function grantAuthority(grants: Grants): StoredAuthority {
  return stored => {
    const matching = grants.filter(grant => grant.subject === stored.id);
    const grant = matching.length === 1 ? matching[0] : undefined;
    if (!grant) return { allowed: false, reason: 'ACTOR_GRANT_REVOKED' };
    if (grant.kind !== stored.kind) return { allowed: false, reason: 'ACTOR_KIND_CHANGED' };
    if (!within(grant.scope, stored.scope)) return { allowed: false, reason: 'ACTOR_SCOPE_REVOKED' };
    const granted = new Set<Permission>(grant.permissions);
    const kept = [...stored.permissions].filter(permission => granted.has(permission));
    const removed = [...stored.permissions].filter(permission => !granted.has(permission));
    return { allowed: true, actor: { ...stored, permissions: new Set(kept) }, removed };
  };
}

/** Accept stored authority as recorded. Only for tests that exercise one worker tick. */
export const unverifiedStoredAuthority: StoredAuthority = stored => ({ allowed: true, actor: stored, removed: [] });
