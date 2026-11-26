import { z } from 'zod';
import { OathweaveError } from '@hivemagnus/hive-common/oathweave';
import { permissions, scopeSchema, type Permission, type Scope } from '@hivemagnus/embermend-contracts';
import { endpoint, responseJson, withoutTrailingSlashes, ResourceTokenProvider } from './index.js';

/**
 * Operator authority derived from Oathweave roles (`EMBERMEND_AUTHORITY_SOURCE=oathweave`).
 *
 * - Permissions: an operator holds Embermend permission `p` while one of its Oathweave roles
 *   (assigned directly or through a group) carries `embermend:p`, for example `embermend:read`
 *   or `embermend:audit:read`. A request also needs `embermend:p` on its token.
 * - Scope: a small mapping names, for each Oathweave role, the installation, applications and
 *   targets it covers. An operator's scope is the union of its mapped roles' scopes; mapped roles
 *   must all name the same installation.
 */

/** The Oathweave permission that carries Embermend permission `permission`. */
export const oathweavePermission = (permission: Permission): string => `embermend:${permission}`;

/** `[{ role, scope }]`: the scope each Oathweave role covers. Role names are unique. */
export const roleScopesSchema = z.array(z.object({ role: z.string().min(1).max(200), scope: scopeSchema }).strict()).max(1000).superRefine((value, context) => {
  if (new Set(value.map(entry => entry.role)).size !== value.length) context.addIssue({ code: 'custom', message: 'Each Oathweave role may be mapped once' });
});
export type RoleScopes = z.infer<typeof roleScopesSchema>;

/** A person's current Oathweave account: whether it is enabled, its effective role names and their permissions. */
export interface OathweaveAccount { active: boolean; roles: readonly string[]; permissions: readonly string[] }
/** The current account of a subject; null when Oathweave has no such user. Throws an `identity_unavailable` OathweaveError when it cannot tell. */
export type AccountLookup = (subject: string) => Promise<OathweaveAccount | null>;

export type RoleAuthorityRefusal = 'OATHWEAVE_ACCOUNT_INACTIVE' | 'OATHWEAVE_ROLE_SCOPE_REQUIRED' | 'OATHWEAVE_ROLE_SCOPE_AMBIGUOUS' | 'OATHWEAVE_ROLE_SCOPE_TOO_LARGE';
export type RoleAuthority = { ok: true; scope: Scope; permissions: Permission[] } | { ok: false; reason: RoleAuthorityRefusal };

const sortedUnion = (lists: ReadonlyArray<readonly string[]>): string[] => [...new Set(lists.flat())].sort();

/** The authority an account's current roles give: refused for a missing or disabled account, no mapped role, mapped roles in more than one installation, or a union over 1000 applications or targets. */
export function roleAuthority(account: OathweaveAccount | null, scopes: RoleScopes): RoleAuthority {
  if (!account?.active) return { ok: false, reason: 'OATHWEAVE_ACCOUNT_INACTIVE' };
  const held = new Set(account.roles);
  const mapped = scopes.filter(entry => held.has(entry.role)).map(entry => entry.scope);
  const first = mapped[0];
  if (!first) return { ok: false, reason: 'OATHWEAVE_ROLE_SCOPE_REQUIRED' };
  if (mapped.some(scope => scope.installationId !== first.installationId)) return { ok: false, reason: 'OATHWEAVE_ROLE_SCOPE_AMBIGUOUS' };
  // The union must still be a valid scope (at most 1000 applications and 1000 targets), as stored work records it.
  const scope = scopeSchema.safeParse({ installationId: first.installationId, applicationIds: sortedUnion(mapped.map(item => item.applicationIds)), targetIds: sortedUnion(mapped.map(item => item.targetIds)) });
  if (!scope.success) return { ok: false, reason: 'OATHWEAVE_ROLE_SCOPE_TOO_LARGE' };
  const granted = new Set(account.permissions);
  return { ok: true, scope: scope.data, permissions: permissions.filter(permission => granted.has(oathweavePermission(permission))) };
}

// Oathweave stores a role's permissions as a JSON string; accept an array too.
const rolePermissions = z.union([z.array(z.string()), z.string()]).transform(value => {
  if (Array.isArray(value)) return value;
  try { const parsed = z.array(z.unknown()).safeParse(JSON.parse(value)); return parsed.success ? parsed.data.filter((entry): entry is string => typeof entry === 'string') : []; } catch { return []; }
});
const roleSchema = z.object({ name: z.string(), permissions: rolePermissions });
const userSchema = z.object({ user: z.object({ id: z.string(), active: z.boolean(), roles: z.array(z.object({ role: roleSchema })) }) });
const groupListSchema = z.object({ groups: z.array(z.object({ id: z.string() })) });
const groupSchema = z.object({ group: z.object({ members: z.array(z.object({ userId: z.string() })), roles: z.array(z.object({ role: roleSchema })) }) });
type Role = z.infer<typeof roleSchema>;

/** Oathweave answered 404: no such user (or group). */
class NotFound extends Error { constructor() { super('NOT_FOUND'); } }

/**
 * Reads a subject's effective roles from the Oathweave admin API with a dedicated machine client
 * holding `iam:users:read` and `iam:groups:read`: the user's direct roles (`GET /users/{id}`)
 * plus the roles of every group it belongs to (`GET /groups`, `GET /groups/{id}`), the same
 * direct-plus-group roles Oathweave puts in tokens. Answers are kept `cacheMs` (default 5 s)
 * and concurrent lookups share requests.
 *
 * Any failure to read (network, timeout, 5xx, a refused or misconfigured machine client, an
 * unexpected answer) is an `identity_unavailable` OathweaveError: callers retry, they never
 * treat it as a revocation. Only a 404 for the user, or `active: false`, says the account is gone.
 */
export class OathweaveDirectory {
  private readonly base: URL; private readonly tokens: ResourceTokenProvider; private readonly cacheMs: number;
  private groups: { at: number; value: Promise<Map<string, Role[]>> } | undefined;
  private readonly accounts = new Map<string, { at: number; value: Promise<OathweaveAccount | null> }>();
  constructor(config: { apiUrl: string; tokenUrl: string; clientId: string; clientSecret: string; cacheMs?: number }, private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    this.base = endpoint(config.apiUrl);
    this.cacheMs = config.cacheMs ?? 5000;
    if (!Number.isInteger(this.cacheMs) || this.cacheMs < 0 || this.cacheMs > 60000) throw new RangeError('Directory cache must be 0-60000 ms');
    this.tokens = new ResourceTokenProvider({ tokenUrl: config.tokenUrl, clientId: config.clientId, clientSecret: config.clientSecret, scope: 'iam:users:read iam:groups:read' }, request);
  }

  readonly lookup: AccountLookup = subject => {
    const at = this.now(); this.prune(at);
    const cached = this.accounts.get(subject); if (cached && at - cached.at < this.cacheMs) return cached.value;
    const value = this.read(subject); this.accounts.set(subject, { at, value });
    // A failed read is not reused: the next lookup asks again.
    value.catch(() => { if (this.accounts.get(subject)?.value === value) this.accounts.delete(subject); });
    return value;
  };

  private prune(at: number): void {
    if (this.accounts.size < 1000) return;
    for (const [key, entry] of this.accounts) if (at - entry.at >= this.cacheMs) this.accounts.delete(key);
  }

  private async read(subject: string): Promise<OathweaveAccount | null> {
    let user: z.infer<typeof userSchema>['user'];
    try { user = userSchema.parse(await this.get(`/users/${encodeURIComponent(subject)}`)).user; } catch (error) { if (error instanceof NotFound) return null; throw unavailable(error); }
    if (user.id !== subject) throw unavailable();
    const groupRoles = (await this.groupRoles()).get(subject) ?? [];
    const roles = [...user.roles.map(entry => entry.role), ...groupRoles];
    return { active: user.active, roles: [...new Set(roles.map(role => role.name))], permissions: [...new Set(roles.flatMap(role => role.permissions))] };
  }

  /** Roles by member user ID, across every group. */
  private groupRoles(): Promise<Map<string, Role[]>> {
    const at = this.now();
    if (this.groups && at - this.groups.at < this.cacheMs) return this.groups.value;
    const value = (async () => {
      try {
        const { groups } = groupListSchema.parse(await this.get('/groups'));
        const byMember = new Map<string, Role[]>();
        for (let index = 0; index < groups.length; index += 8) {
          const details = await Promise.all(groups.slice(index, index + 8).map(async group => {
            try { return groupSchema.parse(await this.get(`/groups/${encodeURIComponent(group.id)}`)).group; } catch (error) { if (error instanceof NotFound) return undefined; throw error; }
          }));
          for (const group of details) {
            if (!group) continue; // deleted since the list was read
            for (const member of group.members) byMember.set(member.userId, [...(byMember.get(member.userId) ?? []), ...group.roles.map(entry => entry.role)]);
          }
        }
        return byMember;
      } catch (error) { throw unavailable(error); }
    })();
    this.groups = { at, value };
    value.catch(() => { if (this.groups?.value === value) this.groups = undefined; });
    return value;
  }

  private async get(path: string, retried = false): Promise<unknown> {
    const target = new URL(this.base); target.pathname = withoutTrailingSlashes(this.base.pathname) + path;
    const response = await this.request(target, { method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${await this.tokens.token()}`, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (response.status === 404) { await response.body?.cancel(); throw new NotFound(); }
    if (response.status === 401 && !retried) { await response.body?.cancel(); this.tokens.invalidate(); return this.get(path, true); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OATHWEAVE_DIRECTORY_HTTP_${response.status}`); }
    return responseJson(response);
  }
}

const unavailable = (cause?: unknown): OathweaveError => cause instanceof OathweaveError ? cause : new OathweaveError('identity_unavailable', { cause });
