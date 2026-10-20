/**
 * §16 S1 gate: "/demo/<key>/whoami returns path=/whoami and tenant_header=<key>,
 * query preserved, slash-less form 301s — prefix test, including a POST with a
 * body under /demo/".
 *
 * nginx strips the prefix (C-2) and the app never rewrites an inbound path, so
 * the request that reaches the app is /whoami with the two override headers.
 * test/helpers/edge.ts replays exactly those nginx rules; the config that
 * produces them is asserted in test/nginx-config.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp, type AppHandle } from '../app/main.ts';
import { loadEnv } from '../app/env.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { edge } from './helpers/edge.ts';
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

interface Whoami {
  path: string;
  tenant_header: string | null;
  tenant: string;
  via: string;
  prefix: string | null;
  method: string;
  query: string;
  url: string;
  body_bytes: number;
}

test('GET /demo/acme/whoami -> path=/whoami, tenant_header=acme, query preserved', async () => {
  const e = edge('/demo/acme/whoami?x=1&y=two');
  assert.equal(e.kind, 'proxied');
  if (e.kind !== 'proxied') return;
  const res = await call({ port, path: e.path, host: 'demos.skw.test', headers: e.headers });
  assert.equal(res.status, 200);
  const body = res.json as Whoami;
  assert.equal(body.path, '/whoami');
  assert.equal(body.tenant_header, 'acme');
  assert.equal(body.tenant, 'acme');
  assert.equal(body.via, 'header');
  assert.equal(body.prefix, '/demo/acme');
  assert.equal(body.query, 'x=1&y=two');
});

test('POST /demo/acme/whoami carries its body through the prefix location', async () => {
  const e = edge('/demo/acme/whoami');
  assert.equal(e.kind, 'proxied');
  if (e.kind !== 'proxied') return;
  const res = await call({
    port,
    path: e.path,
    method: 'POST',
    host: 'demos.skw.test',
    headers: { ...e.headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=ada&ok=1',
  });
  assert.equal(res.status, 200);
  const body = res.json as Whoami;
  assert.equal(body.path, '/whoami');
  assert.equal(body.method, 'POST');
  assert.equal(body.body_bytes, Buffer.byteLength('name=ada&ok=1'));
});

test('the slash-less form 301s to the slash form and keeps the query', () => {
  const e = edge('/demo/beta?x=1');
  assert.deepEqual(e, { kind: 'redirect', status: 301, location: '/demo/beta/?x=1' });
});

test('a well-formed key that is absent from control.db is 404', async () => {
  const e = edge('/demo/zzz/whoami');
  assert.equal(e.kind, 'proxied');
  if (e.kind !== 'proxied') return;
  const res = await call({ port, path: e.path, host: 'demos.skw.test', headers: e.headers });
  assert.equal(res.status, 404);
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('the app never strips a prefix itself: /demo/acme at the app is 404, not /', async () => {
  const res = await call({ port, path: '/demo/acme', host: 'demos.skw.test' });
  assert.equal(res.status, 404);
});

test('host-routed /whoami reports the host resolution and a null header', async () => {
  const res = await call({ port, path: '/whoami', host: 'acme.test' });
  assert.equal(res.status, 200);
  const body = res.json as Whoami;
  assert.equal(body.tenant, 'acme');
  assert.equal(body.via, 'host');
  assert.equal(body.tenant_header, null);
  assert.equal(body.prefix, null);
});
