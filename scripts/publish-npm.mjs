#!/usr/bin/env node
// Publish the release workflow's attested package tarballs to npm through trusted publishing
// (OIDC) with provenance, in dependency order. A version already on npm is skipped, never
// overwritten. Used only by .github/workflows/release.yml.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = process.argv[2] ?? 'release-assets';
const version = (process.env.GITHUB_REF_NAME ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Exact release version tag required');
const files = readdirSync(directory);
for (const name of ['contracts', 'integrations', 'ardent-plugin']) {
  const tarball = `hivemagnus-embermend-${name}-${version}.tgz`;
  if (!files.includes(tarball)) throw new Error(`Missing ${tarball}`);
  const spec = `@hivemagnus/embermend-${name}@${version}`;
  let published = '';
  try { published = execFileSync('npm', ['view', spec, 'version'], { encoding: 'utf8' }).trim(); } catch { /* not published yet */ }
  if (published === version) { console.log(`${spec} is already on npm; skipped`); continue; }
  // An absolute path: npm reads a bare relative path such as `release-assets/x.tgz` as a
  // GitHub `owner/repo` shorthand and tries to clone it.
  execFileSync('npm', ['publish', resolve(directory, tarball), '--provenance', '--access', 'public'], { stdio: 'inherit' });
}
