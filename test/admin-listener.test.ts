/**
 * §16 S1 gate: "a demo Host gets 421 from the admin listener — listener test".
 *
 * §5.6 / C-25: a host that serves tenant-authored HTML never serves the admin
 * listener, and the admin listener returns 421 SKW_E_PLT_EDGE_PROOF for any
 * request whose Host maps to a tenant with mode='demo'.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { listenerFor, buildApp, type AppHandle } from '../app/main.ts';
import { loadEnv } from '../app/env.ts';
import { EDGE_TOKEN, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';

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

test('a demo Host is 421 on the admin listener', async () => {
  const res = await call({ port, path: '/admin/t/acme/pages', host: 'acme-demo.test' });
  assert.equal(res.status, 421);
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_PLT_EDGE_PROOF');
});

test('a demo Host is 421 even with a valid tenant header', async () => {
  const res = await call({
    port,
    path: '/admin/t/acme/pages',
    host: 'acme-demo.test',
    headers: { 'x-skunkworks-tenant': 'acme', 'x-skunkworks-edge': EDGE_TOKEN },
  });
  assert.equal(res.status, 421);
});

test('the admin listener refuses a tenant header that is present at all', async () => {
  const res = await call({
    port,
    path: '/admin/t/acme/pages',
    host: 'acme.test',
    headers: { 'x-skunkworks-tenant': 'acme', 'x-skunkworks-edge': EDGE_TOKEN },
  });
  assert.equal(res.status, 421);
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_PLT_EDGE_PROOF');
});

test('the admin listener ignores Host for tenant resolution (no session -> 404, not acme)', async () => {
  const res = await call({ port, path: '/admin/t/acme/pages', host: 'acme.test' });
  assert.equal(res.status, 404);
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('the public listener is not the admin listener', async () => {
  assert.equal(listenerFor('/pricing', 'acme.test', 'admin.skw.test'), 'public');
  assert.equal(listenerFor('/admin/t/acme/pages', 'acme.test', 'admin.skw.test'), 'admin');
  assert.equal(listenerFor('/pricing', 'admin.skw.test', 'admin.skw.test'), 'admin');
  assert.equal(listenerFor('/adminish', 'acme.test', 'admin.skw.test'), 'public');
});
