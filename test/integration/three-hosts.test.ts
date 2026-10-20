/**
 * §16 S1 gate: "GET /pricing on a mapped host renders the tenant's page —
 * integration test, 3 hosts".
 *
 * Three Host headers, one process, one Astro mount. The assertions are about
 * which cms_page row came back, not about a 200.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp, type AppHandle } from '../../app/main.ts';
import { loadEnv } from '../../app/env.ts';
import { makeFixture, type Fixture } from '../helpers/fixture.ts';
import { call } from '../helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

before(async () => {
  fixture = makeFixture();
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

async function get(host: string, path = '/pricing') {
  return call({ port, path, host, method: 'GET' });
}

test('acme.test renders Acme\'s /pricing from its own site.db', async () => {
  const res = await get('acme.test');
  assert.equal(res.status, 200);
  assert.match(res.body, /<h1>Acme pricing<\/h1>/);
  assert.match(res.body, /data-tenant="acme"/);
});

test('www.acme.test (an alias) renders the same tenant', async () => {
  const res = await get('www.acme.test');
  assert.equal(res.status, 200);
  assert.match(res.body, /<h1>Acme pricing<\/h1>/);
});

test('beta.test renders Beta\'s /pricing, not Acme\'s', async () => {
  const res = await get('beta.test');
  assert.equal(res.status, 200);
  assert.match(res.body, /<h1>Beta pricing<\/h1>/);
  assert.doesNotMatch(res.body, /Acme pricing/);
  assert.match(res.body, /data-tenant="beta"/);
});

test('an unmapped Host is 404 SKW_E_PLT_TENANT_UNKNOWN, with no default tenant', async () => {
  const res = await get('nobody.test');
  assert.equal(res.status, 404);
  const body = res.json as { error: { code: string; requestId: string } };
  assert.equal(body.error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(typeof body.error.requestId, 'string');
});

test('a path with no cms_page row is 404 and never falls through to another tenant', async () => {
  const res = await get('acme.test', '/no-such-page');
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.body, /Beta pricing/);
});

test('the page response is no-store (v1 has no CDN, §5.5)', async () => {
  const res = await get('acme.test');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('/healthz reports SKW_BUILD_ID and touches nothing (§9.5)', async () => {
  const res = await call({ port, path: '/healthz', host: 'acme.test' });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json as object).sort(), ['build', 'uptime']);
  assert.equal((res.json as { build: string }).build, 'test-build');
});
