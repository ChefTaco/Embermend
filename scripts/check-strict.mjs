import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const failures = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'generated'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await walk(path); continue; }
    if (entry.name === 'package.json') {
      const value = JSON.parse(await readFile(path, 'utf8'));
      for (const group of ['dependencies', 'devDependencies']) if (value[group]?.typescript && value[group].typescript !== '6.0.3') failures.push(`${path}: TypeScript must be exactly 6.0.3`);
    }
    if (!entry.name.endsWith('.ts')) continue;
    const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (node.kind === ts.SyntaxKind.AnyKeyword || ts.isNonNullExpression(node) || ts.isAsExpression(node) && !['const', 'unknown'].includes(node.type.getText(source))) failures.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: unsafe type escape`);
      ts.forEachChild(node, visit);
    }; visit(source);
  }
}
const config = JSON.parse(await readFile('tsconfig.base.json', 'utf8'));
for (const key of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) if (config.compilerOptions[key] !== true) failures.push(`${key} must be enabled`);
await walk('packages'); await walk('services'); await walk('test');
if (failures.length) throw new Error(failures.join('\n'));
console.log('TypeScript 6.0.3 and strict typing boundaries verified.');
