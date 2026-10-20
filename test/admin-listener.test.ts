/**
 * §16 S1 gate as amended by 02-errata E-2: "a demo `Host` cannot reach the admin
 * surface: `/admin/…` is `404` with the same body as an unknown path, and no
 * admin route is mounted on a public listener".
 *
 * §9.1: the admin surface is a **hostname**, and that hostname is the only thing
 * that makes a request an admin request. The path never selects the listener.
 * §9.2: the admin listener ignores `Host` for tenant resolution and refuses a
 * tenant header that is present at all.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { listenerFor, buildApp, type AppHandle } from '../app/main.ts';
import { loadEnv } from '../app/env.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const ADMIN_HOST = 'admin.skw.test';

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

/** The body with the per-request id removed, so two responses can be compared. */
function scrub(res: Res): string {
  const parsed = res.json as { error?: { requestId?: string } } | undefined;
  if (parsed?.error !== undefined && parsed.error.requestId !== undefined) {
    return JSON.stringify({ ...parsed, error: { ...parsed.error, requestId: '<request-id>' } });
  }
  return res.body;
}

test('(a) the listener is the admin hostname, and the path never selects it', () => {
  // Every tuple E-2 (a) names, with the path kept as documentation: each row is
  // evaluated with the Host alone, which is the point.
  const table: [path: string, host: string | null, expected: 'public' | 'admin'][] = [
    ['/admin/t/acme/pages', 'acme.test', 'public'],
    ['/admin', 'acme.test', 'public'],
    ['/adminish', 'acme.test', 'public'],
    ['/admin/t/acme/pages', ADMIN_HOST, 'admin'],
    ['/pricing', ADMIN_HOST, 'admin'],
    ['/admin', null, 'public'],
    ['/admin', 'ADMIN.SKW.TEST.', 'admin'],
    ['/admin', 'admin.skw.test:8443', 'admin'],
  ];
  for (const [path, host, expected] of table) {
    assert.equal(listenerFor(host, ADMIN_HOST), expected, `${path} on ${String(host)}`);
  }
});

test('(b) /admin/t/acme/pages on a tenant host is the same 404 as an unknown path, with no Set-Cookie', async () => {
  const adminish = await call({ port, path: '/admin/t/acme/pages', host: 'acme.test' });
  assert.equal(adminish.status, 404);
  assert.equal((adminish.json as { error: { code: string } }).error.code, 'SKW_E_RT_PAGE_NOT_FOUND');
  assert.equal(adminish.headers['set-cookie'], undefined);

  const unknown = await call({ port, path: '/no-such-page', host: 'acme.test' });
  assert.equal(unknown.status, 404);
  assert.equal(scrub(adminish), scrub(unknown), 'the admin path must be byte-identical to any unmatched path');
});

test('(c) the same path on a demo host is the same 404, not a 421', async () => {
  const res = await call({ port, path: '/admin/t/acme/pages', host: 'acme-demo.test' });
  assert.equal(res.status, 404, 'a demo host no longer reaches a 421: the admin surface is not mounted there');
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_RT_PAGE_NOT_FOUND');
  assert.equal(res.headers['set-cookie'], undefined);
});

test('(d) the admin host with no session is 404 SKW_E_PLT_TENANT_UNKNOWN on every path', async () => {
  const adminPath = await call({ port, path: '/admin/t/acme/pages', host: ADMIN_HOST });
  assert.equal(adminPath.status, 404);
  assert.equal((adminPath.json as { error: { code: string } }).error.code, 'SKW_E_PLT_TENANT_UNKNOWN');

  // §9.1 rule 2: the admin host serves the admin surface and nothing else.
  const pricing = await call({ port, path: '/pricing', host: ADMIN_HOST });
  assert.equal(pricing.status, 404);
  assert.equal((pricing.json as { error: { code: string } }).error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('(d2) the admin host refuses a tenant header that is present at all (row 1)', async () => {
  for (const value of ['acme', '']) {
    const res = await call({
      port,
      path: '/admin/t/acme/pages',
      host: ADMIN_HOST,
      headers: { 'x-skunkworks-tenant': value },
    });
    assert.equal(res.status, 421, `header ${JSON.stringify(value)} on the admin host`);
    assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_PLT_EDGE_PROOF');
  }
});
