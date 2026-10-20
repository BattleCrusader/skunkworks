/**
 * §16 S1 gate: "GET /pricing on a mapped host renders the tenant's page —
 * integration test, 3 hosts".
 *
 * Three Host headers, one process, one Astro mount. The assertions are about
 * which cms_page row came back, not about a 200.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

import { buildApp, type AppHandle } from '../../app/main.ts';
import { loadEnv } from '../../app/env.ts';
import { makeFixture, type Fixture } from '../helpers/fixture.ts';
import { call, postRaw } from '../helpers/http.ts';

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

test('a path with no cms_page row is 404 SKW_E_RT_PAGE_NOT_FOUND and never falls through to another tenant', async () => {
  const res = await get('acme.test', '/no-such-page');
  assert.equal(res.status, 404);
  const body = res.json as { error: { code: string } };
  // §4.3 (E-4): the tenant resolved, so "no tenant" would be a false statement.
  assert.equal(body.error.code, 'SKW_E_RT_PAGE_NOT_FOUND');
  assert.equal(res.headers['cache-control'], 'no-store', 'a page miss must not be cacheable');
  assert.doesNotMatch(res.body, /Beta pricing/);
});

test('a malformed JSON body is 400 SKW_E_PLT_REQUEST_INVALID, not a borrowed 503 (§4.3 E-4)', async () => {
  const res = await call({
    port,
    path: '/pricing',
    method: 'POST',
    host: 'acme.test',
    headers: { 'content-type': 'application/json' },
    body: '{"broken": ',
  });
  assert.equal(res.status, 400);
  const body = res.json as { error: { code: string } };
  assert.equal(body.error.code, 'SKW_E_PLT_REQUEST_INVALID');
});

test('a 17 MiB body direct to the app is 413 SKW_E_PLT_BODY_TOO_LARGE (§4.3 E-4)', async () => {
  const res = await postRaw({ port, path: '/whoami', host: 'acme.test', bytes: 17 * 1024 * 1024 });
  assert.equal(res.status, 413);
  const body = res.json as { error: { code: string } };
  assert.equal(body.error.code, 'SKW_E_PLT_BODY_TOO_LARGE');
});

test('a route that throws is 500 SKW_E_PLT_INTERNAL with a requestId and no stack, path or SQL (§4.3 E-4)', async () => {
  // /readyz performs a scratch write under <dataDir>/logs; a regular file there
  // makes the route throw a non-AppError. That is the unhandled-error path.
  const brokenLogs = join(fixture.dir, 'logs');
  writeFileSync(brokenLogs, 'not a directory\n');
  try {
    const res = await call({ port, path: '/readyz', host: 'acme.test' });
    assert.equal(res.status, 500);
    const body = res.json as { error: { code: string; requestId: string; detail?: unknown } };
    assert.equal(body.error.code, 'SKW_E_PLT_INTERNAL');
    assert.equal(typeof body.error.requestId, 'string');
    assert.equal(body.error.detail, undefined);
    assert.doesNotMatch(res.body, /at |\.ts:|SELECT |PRAGMA |\/Volumes|\/tmp/);
  } finally {
    rmSync(brokenLogs, { force: true });
  }
});

test('E-13 — an HTTP/1.1 request with no Host is 400 before the app, and names no tenant', async () => {
  // Node answers this before the app sees it, which is why §4.3 names it as one of
  // the four responses that cannot carry a taxonomy body (QA's m6).
  const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const sock = connect(port, '127.0.0.1');
    let data = '';
    sock.on('connect', () => sock.write('GET /pricing HTTP/1.1\r\nConnection: close\r\n\r\n'));
    sock.on('data', (c) => (data += c.toString('utf8')));
    sock.on('end', () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0);
      resolve({ status, body: data.slice(data.indexOf('\r\n\r\n') + 4) });
    });
    sock.on('error', reject);
  });
  assert.equal(raw.status, 400);
  assert.doesNotMatch(raw.body, /tenant/i, 'a request with no Host names no tenant');
  // Nothing is asserted about the body's shape: it is Node's, not the app's.
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
