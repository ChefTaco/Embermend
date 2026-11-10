import { z } from 'zod';
import { revision, type PreparationResult } from '@hivemagnus/embermend-contracts';
import { endpoint, responseJson, IntegrationError } from './index.js';

const repositorySchema = z.object({ id: z.number().int().positive(), full_name: z.string(), owner: z.object({ login: z.string() }), name: z.string(), default_branch: z.string() });
const commitSchema = z.object({ sha: revision, commit: z.object({ tree: z.object({ sha: revision }) }) });
const objectSchema = z.object({ sha: revision });
export interface GitHubRepositoryGrant { providerId: string; owner: string; name: string; allowedBranches: readonly string[]; workflowIds: readonly string[] }
const mergeWire = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), details: z.object({ uuid: z.uuid(), expected_head_sha: revision, merge_method: z.string(), merge_action: z.string(), bypass_rules: z.boolean().optional() }) }),
  z.object({ status: z.literal('merged'), details: z.object({ sha: revision }) }),
  z.object({ status: z.literal('enqueued'), details: z.object({}) }),
  z.object({ status: z.literal('failed'), details: z.object({}) }),
]);
const mergeIdentity = { providerId: z.string(), pullNumber: z.number().int().positive(), headCommit: revision, bypassRules: z.literal(false) };
export const githubMergeOperationSchema = z.discriminatedUnion('state', [
  z.object({ ...mergeIdentity, state: z.literal('pending'), requestId: z.uuid(), commit: z.null() }).strict(),
  z.object({ ...mergeIdentity, state: z.literal('enqueued'), requestId: z.uuid().nullable(), commit: z.null() }).strict(),
  z.object({ ...mergeIdentity, state: z.literal('merged'), requestId: z.uuid().nullable(), commit: revision }).strict(),
  z.object({ ...mergeIdentity, state: z.literal('failed'), requestId: z.uuid().nullable(), commit: z.null() }).strict(),
]);
export type GitHubMergeOperation = z.infer<typeof githubMergeOperationSchema>;
export class GitHubClient {
  private readonly base: URL;
  constructor(private readonly token: string, private readonly grants: readonly GitHubRepositoryGrant[], private readonly request: typeof fetch = fetch, base = 'https://api.github.com') { this.base = endpoint(base); }
  private async exchange(path: string, method = 'GET', body?: unknown, readOnly = false, options: { version?: string; acceptedStatuses?: readonly number[] } = {}): Promise<{ status: number; body: unknown }> {
    try {
      const response = await this.request(new URL(path, this.base), { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${this.token}`, 'content-type': 'application/json', 'x-github-api-version': options.version ?? '2022-11-28' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok && !options.acceptedStatuses?.includes(response.status)) throw new IntegrationError(`GITHUB_HTTP_${response.status}`, method !== 'GET' && !readOnly && response.status >= 500);
      if (response.status === 204) return { status: 204, body: { accepted: true } };
      return { status: response.status, body: await responseJson(response) };
    } catch (error) { if (error instanceof IntegrationError) throw error; throw new IntegrationError('GITHUB_COMMUNICATION_OR_SCHEMA_FAILURE', method !== 'GET' && !readOnly); }
  }
  private async call(path: string, method = 'GET', body?: unknown, readOnly = false): Promise<unknown> { return (await this.exchange(path, method, body, readOnly)).body; }
  async repository(providerId: string) {
    const grant = this.grants.find(value => value.providerId === providerId); if (!grant) throw new Error('REPOSITORY_PROVIDER_GRANT_REQUIRED');
    const repository = repositorySchema.parse(await this.call(`/repositories/${encodeURIComponent(providerId)}`));
    if (String(repository.id) !== providerId || repository.owner.login !== grant.owner || repository.name !== grant.name) throw new Error('REPOSITORY_TRANSFER_OR_RENAME_REQUIRES_ACCESS_REVIEW');
    return { repository, grant, path: `/repos/${encodeURIComponent(repository.owner.login)}/${encodeURIComponent(repository.name)}` };
  }
  async resolve(providerId: string, ref: string): Promise<string> { const { path } = await this.repository(providerId); return commitSchema.parse(await this.call(`${path}/commits/${encodeURIComponent(ref)}`)).sha; }
  async createTree(providerId: string, prepared: PreparationResult): Promise<string> {
    const { path } = await this.repository(providerId); const base = commitSchema.parse(await this.call(`${path}/commits/${prepared.baseCommit}`));
    // A single bounded provider mutation creates the tree. No repository script
    // or isolated worker receives this integration's write credential.
    const tree = prepared.edits.map(edit => edit.content === null ? { path: edit.path, mode: '100644', type: 'blob', sha: null } : { path: edit.path, mode: '100644', type: 'blob', content: edit.content });
    return objectSchema.parse(await this.call(`${path}/git/trees`, 'POST', { base_tree: base.commit.tree.sha, tree })).sha;
  }
  async createCommit(providerId: string, baseCommit: string, tree: string, operationId: string): Promise<string> {
    const { path } = await this.repository(providerId);
    // Do not let a provider infer an operator's private profile email for a
    // public automation commit. Authorization is retained in the product audit.
    const identity = { name: 'Embermend', email: 'automation@example.com' };
    return objectSchema.parse(await this.call(`${path}/git/commits`, 'POST', { message: `fix: remediate verified security finding\n\nEmbermend operation: ${operationId}`, tree, parents: [revision.parse(baseCommit)], author: identity, committer: identity })).sha;
  }
  async createBranch(providerId: string, branch: string, commit: string): Promise<string> {
    const { path } = await this.repository(providerId);
    if (!/^embermend\/[a-zA-Z0-9._-]{1,100}$/.test(branch)) throw new Error('DEDICATED_REMEDIATION_BRANCH_REQUIRED');
    const result = z.object({ ref: z.string(), object: objectSchema }).parse(await this.call(`${path}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: revision.parse(commit) })); return result.ref;
  }
  async createPullRequest(providerId: string, branch: string, base: string, operationId: string): Promise<{ number: number; url: string; headCommit: string }> {
    const { path, grant } = await this.repository(providerId); if (!grant.allowedBranches.includes(base)) throw new Error('BASE_BRANCH_OUTSIDE_PROVIDER_GRANT');
    const result = z.object({ number: z.number().int().positive(), html_url: z.url(), head: z.object({ sha: revision }) }).parse(await this.call(`${path}/pulls`, 'POST', { title: 'Remediate verified security finding', head: branch, base, body: `Prepared and validated by Embermend.\n\nOperation: ${operationId}\n\nMerge and deployment require separate authorization.`, draft: false })); return { number: result.number, url: result.html_url, headCommit: result.head.sha };
  }
  async findPullRequest(providerId: string, expected: { branch: string; base: string; headCommit: string; operationId: string }): Promise<{ number: number; url: string; headCommit: string; state: 'open' | 'closed' } | null> {
    const { path, grant } = await this.repository(providerId);
    if (!grant.allowedBranches.includes(expected.base) || !/^embermend\/[a-zA-Z0-9._-]{1,100}$/.test(expected.branch)) throw new Error('RECONCILIATION_OUTSIDE_PROVIDER_GRANT');
    const ref = z.object({ ref: z.string(), object: z.object({ sha: revision, type: z.literal('commit') }) }).parse(await this.call(`${path}/git/ref/heads/${encodeURIComponent(expected.branch)}`));
    if (ref.ref !== `refs/heads/${expected.branch}` || ref.object.sha !== expected.headCommit) throw new Error('REMEDIATION_BRANCH_HEAD_CHANGED');
    const query = new URLSearchParams({ state: 'all', head: `${grant.owner}:${expected.branch}`, base: expected.base, per_page: '100' });
    const pulls = z.array(z.object({ number: z.number().int().positive(), html_url: z.url(), state: z.enum(['open', 'closed']), body: z.string().nullable(), head: z.object({ ref: z.string(), sha: revision, repo: z.object({ id: z.number().int().positive() }).nullable() }), base: z.object({ ref: z.string(), repo: z.object({ id: z.number().int().positive() }) }) })).parse(await this.call(`${path}/pulls?${query}`));
    if (pulls.length >= 100) throw new Error('PULL_REQUEST_RECONCILIATION_INCOMPLETE');
    const matches = pulls.filter(pull => pull.head.ref === expected.branch && pull.base.ref === expected.base && String(pull.head.repo?.id) === providerId && String(pull.base.repo.id) === providerId);
    if (matches.length > 1) throw new Error('PULL_REQUEST_RECONCILIATION_AMBIGUOUS');
    const pull = matches[0]; if (!pull) return null;
    if (pull.head.sha !== expected.headCommit || !pull.body?.split(/\r?\n/).includes(`Operation: ${expected.operationId}`)) throw new Error('PULL_REQUEST_RECONCILIATION_IDENTITY_CHANGED');
    return { number: pull.number, url: pull.html_url, headCommit: pull.head.sha, state: pull.state };
  }
  async pullRequest(providerId: string, number: number) {
    const { path } = await this.repository(providerId);
    return z.object({ number: z.number(), state: z.string(), merged: z.boolean(), merge_commit_sha: revision.nullable(), head: z.object({ sha: revision, ref: z.string() }), base: z.object({ ref: z.string(), sha: revision }) }).parse(await this.call(`${path}/pulls/${number}`));
  }
  async checks(providerId: string, commit: string) {
    const { path } = await this.repository(providerId);
    return z.object({ total_count: z.number(), check_runs: z.array(z.object({ id: z.number(), name: z.string(), head_sha: revision, status: z.string(), conclusion: z.string().nullable() })) }).parse(await this.call(`${path}/commits/${revision.parse(commit)}/check-runs?per_page=100`));
  }
  async merge(providerId: string, number: number, head: string): Promise<GitHubMergeOperation> {
    const { path, grant } = await this.repository(providerId); const pull = await this.pullRequest(providerId, number);
    if (pull.head.sha !== head || !grant.allowedBranches.includes(pull.base.ref)) throw new Error('PULL_REQUEST_HEAD_OR_BASE_CHANGED');
    const checks = await this.checks(providerId, head);
    if (checks.total_count === 0 || checks.total_count > 100 || checks.total_count !== checks.check_runs.length || new Set(checks.check_runs.map(check => check.id)).size !== checks.total_count || checks.check_runs.some(check => check.head_sha !== head || check.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(check.conclusion ?? ''))) throw new Error('CHECKS_NOT_COMPLETE_AND_PASSING');
    const query = 'query EmbermendMergeReadiness($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){databaseId nameWithOwner pullRequest(number:$number){headRefOid baseRefName baseRefOid isDraft state mergeable mergeStateStatus reviewDecision}}}';
    const readiness = z.object({ data: z.object({ repository: z.object({ databaseId: z.number().int(), nameWithOwner: z.string(), pullRequest: z.object({ headRefOid: revision, baseRefName: z.string(), baseRefOid: revision, isDraft: z.boolean(), state: z.string(), mergeable: z.string(), mergeStateStatus: z.string(), reviewDecision: z.string().nullable() }) }) }), errors: z.undefined().optional() }).parse(await this.call('/graphql', 'POST', { query, variables: { owner: grant.owner, name: grant.name, number } }, true)).data.repository;
    const ready = readiness.pullRequest;
    // Repository role is not a token permission or a reason to skip rules.
    // GitHub's live merge state also includes rules and required reviews that
    // are not represented by the check-runs list. Unknown/blocked states stop.
    if (String(readiness.databaseId) !== providerId || readiness.nameWithOwner !== `${grant.owner}/${grant.name}` || ready.headRefOid !== head || ready.baseRefName !== pull.base.ref || ready.baseRefOid !== pull.base.sha || ready.isDraft || ready.state !== 'OPEN' || ready.mergeable !== 'MERGEABLE' || ready.mergeStateStatus !== 'CLEAN' || ready.reviewDecision !== null && ready.reviewDecision !== 'APPROVED') throw new Error('PROVIDER_MERGE_RULES_NOT_SATISFIED');
    const current = await this.pullRequest(providerId, number);
    if (current.head.sha !== head || current.base.ref !== ready.baseRefName || current.base.sha !== ready.baseRefOid || current.state !== 'open' || current.merged) throw new Error('PULL_REQUEST_HEAD_OR_BASE_CHANGED');
    // The asynchronous API explicitly refuses rule bypass for every identity,
    // including administrators and apps, and respects a configured merge queue.
    const reply = await this.exchange(`${path}/pulls/${number}/merge-async`, 'PUT', { sha: revision.parse(head), merge_method: 'squash', merge_action: 'default', bypass_rules: false }, false, { version: '2026-03-10', acceptedStatuses: [400, 409] });
    const result = mergeWire.parse(reply.body);
    if (result.status === 'pending' && (result.details.expected_head_sha !== head || result.details.bypass_rules === true || result.details.merge_method !== 'squash' || result.details.merge_action !== 'default' || reply.status === 409 && result.details.bypass_rules !== false)) throw new IntegrationError('GITHUB_EXISTING_MERGE_OPTIONS_DIFFER', true);
    const requestId = result.status === 'pending' ? result.details.uuid : null;
    return githubMergeOperationSchema.parse({ providerId, pullNumber: number, headCommit: head, bypassRules: false, state: result.status, requestId, commit: result.status === 'merged' ? result.details.sha : null });
  }
  async observeMerge(providerId: string, raw: unknown): Promise<GitHubMergeOperation> {
    const operation = githubMergeOperationSchema.parse(raw); if (operation.providerId !== providerId) throw new Error('MERGE_PROVIDER_IDENTITY_CHANGED');
    const { path, grant } = await this.repository(providerId);
    let status: z.infer<typeof mergeWire> | undefined;
    if (operation.requestId) {
      // GitHub expires request results after 24 hours. An expired UUID is not
      // proof of completion or absence; inspect the original PR without replay.
      try { status = mergeWire.parse((await this.exchange(`${path}/pulls/${operation.pullNumber}/merge-async/${operation.requestId}`, 'GET', undefined, true, { version: '2026-03-10' })).body); }
      catch (error) { if (!(error instanceof IntegrationError) || error.message !== 'GITHUB_HTTP_404') throw error; }
      if (status?.status === 'pending' && (status.details.uuid !== operation.requestId || status.details.expected_head_sha !== operation.headCommit || status.details.bypass_rules === true || status.details.merge_method !== 'squash' || status.details.merge_action !== 'default')) throw new Error('MERGE_PROVIDER_IDENTITY_CHANGED');
      if (status?.status === 'failed') return { ...operation, state: 'failed', commit: null };
    }
    const pull = await this.pullRequest(providerId, operation.pullNumber);
    if (pull.head.sha !== operation.headCommit || !grant.allowedBranches.includes(pull.base.ref)) throw new Error('MERGE_PULL_REQUEST_HEAD_OR_BASE_CHANGED');
    if (pull.merged) {
      if (!pull.merge_commit_sha || status?.status === 'merged' && status.details.sha !== pull.merge_commit_sha) throw new Error('MERGE_COMMIT_EVIDENCE_CHANGED');
      return { ...operation, state: 'merged', commit: pull.merge_commit_sha };
    }
    if (pull.state !== 'open' || status?.status === 'merged') throw new Error('MERGE_PROVIDER_COMPLETION_UNCONFIRMED');
    return status?.status === 'enqueued' ? { ...operation, state: 'enqueued', commit: null } : operation;
  }
  async workflow(providerId: string, workflowId: string, commit: string, branch: string): Promise<unknown> {
    const { path, grant } = await this.repository(providerId); if (!grant.workflowIds.includes(workflowId) || !grant.allowedBranches.includes(branch)) throw new Error('WORKFLOW_OUTSIDE_PROVIDER_GRANT');
    if (await this.resolve(providerId, branch) !== commit) throw new Error('WORKFLOW_BRANCH_CHANGED');
    return this.call(`${path}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, 'POST', { ref: branch, inputs: { embermend_commit: commit } });
  }
  async run(providerId: string, runId: number) {
    const { path } = await this.repository(providerId); return z.object({ id: z.number(), head_sha: revision, status: z.string(), conclusion: z.string().nullable(), html_url: z.url() }).parse(await this.call(`${path}/actions/runs/${runId}`));
  }
}
