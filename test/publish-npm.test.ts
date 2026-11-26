import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const script = resolve('scripts/publish-npm.mjs');

test('npm publication passes each tarball as an absolute file path, in dependency order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'embermend-publish-'));
  try {
    const bin = join(root, 'bin');
    await mkdir(bin);
    await mkdir(join(root, 'release-assets'));
    for (const name of ['contracts', 'integrations', 'ardent-plugin']) {
      await writeFile(join(root, 'release-assets', `hivemagnus-embermend-${name}-9.8.7.tgz`), 'fake');
    }
    const log = join(root, 'npm.log');
    // A fake npm: `view` reports the version as unpublished, every call is recorded.
    await writeFile(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$1" = view ] && exit 1\nexit 0\n`);
    await chmod(join(bin, 'npm'), 0o755);
    execFileSync(process.execPath, [script, 'release-assets'], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_REF_NAME: 'v9.8.7' },
      stdio: 'pipe',
    });
    const publishes = (await readFile(log, 'utf8')).split('\n').filter((line) => line.startsWith('publish '));
    assert.equal(publishes.length, 3);
    const paths = publishes.map((line) => line.split(' ')[1] ?? '');
    for (const path of paths) assert.ok(isAbsolute(path), path);
    assert.deepEqual(paths, ['contracts', 'integrations', 'ardent-plugin'].map((name) => join(root, 'release-assets', `hivemagnus-embermend-${name}-9.8.7.tgz`)));
    for (const line of publishes) assert.match(line, / --provenance --access public$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
