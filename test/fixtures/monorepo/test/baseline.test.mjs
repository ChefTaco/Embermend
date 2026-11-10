import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchCatalog } from '../apps/catalog/src/catalog.ts';
test('the inert baseline accepts an injected database adapter', async () => {
  let observed = '';
  await searchCatalog({ query: async sql => { observed = sql; return []; } }, 'fixture');
  assert.match(observed, /catalog/);
});
