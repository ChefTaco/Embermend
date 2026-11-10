import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const destination = process.argv[2];
if (!destination) throw new Error('Pass the HiveXUI contracts directory');
const root = new URL('../', import.meta.url);
const sourcePath = 'packages/contracts/src/index.ts';
const source = await readFile(new URL(sourcePath, root), 'utf8');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const committed = execFileSync('git', ['show', `${revision}:${sourcePath}`], { cwd: root, encoding: 'utf8' });
if (source !== committed) throw new Error('Commit the public contracts before exporting immutable browser provenance');
for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/gu)) if ((match[1] ?? match[2]) !== 'zod') throw new Error('Browser contracts may import only Zod');
const version = /export const VERSION = '([^']+)'/.exec(source)?.[1];
if (!version) throw new Error('Public contract version missing');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const content = `// Generated from Embermend public contracts; source SHA-256 ${sha(source)}.\n// Regenerate using Embermend scripts/export-browser-contracts.mjs.\n${source}`;
const provenance = { schema: 1, product: 'embermend-browser', version, repository: 'https://github.com/ChefTaco/Embermend', revision, files: [{ path: 'embermend.generated.ts', source: sourcePath, sourceSha256: sha(source), sha256: sha(content) }] };
await mkdir(resolve(destination), { recursive: true });
for (const [name, bytes] of [['embermend.generated.ts', content], ['embermend.provenance.json', JSON.stringify(provenance, null, 2) + '\n']]) {
  const path = resolve(destination, name);
  if (process.argv.includes('--check')) { if (await readFile(path, 'utf8') !== bytes) throw new Error('Browser contract export drift'); }
  else await writeFile(path, bytes);
}
