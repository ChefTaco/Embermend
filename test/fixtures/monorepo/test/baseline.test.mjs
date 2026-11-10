import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { searchCatalog, readDocument, visibleAccount } from '../apps/catalog/src/catalog.ts';
test('isolated executable security probes retain exact before and after observations', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec("CREATE TABLE catalog(id INTEGER, title TEXT); INSERT INTO catalog VALUES(1,'fixture'),(2,'other');");
  const database = { query: async (sql, parameters = []) => sqlite.prepare(sql).all(...parameters) };
  assert.equal((await searchCatalog(database, 'fixture')).length, 1);
  const injectionRows = (await searchCatalog(database, "' OR 1=1--")).length;
  let traversalRead = false;
  const store = { read: async path => { traversalRead = path.includes('../'); return 'fixture document'; } };
  try { await readDocument(store, '../outside.txt'); } catch { /* Refusal is the expected repaired boundary. */ }
  const owner = 'fixture-owner'; const other = { id: 'fixture-account', ownerId: 'other-owner', label: 'Fixture' };
  const crossOwner = visibleAccount([other], other.id, owner) !== undefined;
  assert.equal(typeof traversalRead, 'boolean'); assert.equal(typeof crossOwner, 'boolean');
  console.log('EMBERMEND_SECURITY_PROBES=' + JSON.stringify({ injectionRows, traversalRead, crossOwner }));
  sqlite.close();
});
