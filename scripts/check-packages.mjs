import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const manifests = readdirSync('packages', { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => JSON.parse(readFileSync(`packages/${entry.name}/package.json`, 'utf8')));
const local = new Map(manifests.map(manifest => [manifest.name, manifest]));
for (const manifest of manifests.filter(manifest => !manifest.private)) {
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    const dependency = local.get(name);
    if (dependency && (dependency.private || dependency.version !== version)) throw new Error(`${manifest.name}: unpublished or unpinned local dependency ${name}`);
  }
  const result = JSON.parse(execFileSync('npm', ['pack', '--workspace', manifest.name, '--json', '--dry-run', '--ignore-scripts'], { encoding: 'utf8' }));
  if (result.length !== 1) throw new Error('Unexpected package result');
  const paths = result[0].files.map(file => file.path);
  for (const required of ['LICENSE', 'NOTICE', 'README.md', 'dist/index.js', 'dist/index.d.ts']) if (!paths.includes(required)) throw new Error(`${manifest.name}: missing ${required}`);
  if (paths.some(path => /(^|\/)(state|output|node_modules|src)\/|(^|\/)\.env|\.test\./u.test(path))) throw new Error(`${manifest.name}: unexpected package content`);
  console.log(`Verified package boundary: ${manifest.name}@${manifest.version}`);
}
