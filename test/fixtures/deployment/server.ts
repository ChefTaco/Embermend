/** Inert disposable acceptance application; fake records only. Never deploy as a product. */
import { createServer } from 'node:http';
const mode = process.env['REMEDIATION_MODE'];
if (mode !== 'baseline' && mode !== 'fixed') throw new Error('Explicit acceptance fixture mode required');
const sourceCommit = process.env['SOURCE_COMMIT'];
if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Immutable fixture source required');
createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture.example.com');
  response.setHeader('content-type', 'application/json');
  if (url.pathname === '/health') { response.end(JSON.stringify({ status: 'healthy', mode, sourceCommit })); return; }
  const owner: unknown = request.headers['x-fixture-owner'];
  if (url.pathname !== '/account' || url.searchParams.get('id') !== 'fixture-account' || typeof owner !== 'string' || !['alice', 'bob'].includes(owner)) { response.writeHead(400); response.end('{}'); return; }
  if (mode === 'fixed' && owner !== 'alice') { response.writeHead(403); response.end(JSON.stringify({ error: 'owner-denied' })); return; }
  response.end(JSON.stringify({ id: 'fixture-account', owner: 'alice', label: 'Inert acceptance record' }));
}).listen(8088, '0.0.0.0');
