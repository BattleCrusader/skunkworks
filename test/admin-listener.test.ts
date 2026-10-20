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
import Database from 'better-sqlite3';

import { listenerFor, buildApp, type AppHandle } from '../app/main.ts';
import { loadEnv } from '../app/env.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';
import { TOTP_SECRET, openSession, seedUser } from './helpers/admin.ts';

const ADMIN_HOST = 'admin.skw.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

before(async () => {
  fixture = makeFixture();
  // S2a: the "public listener does not parse the cookie" case needs a real one.
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'oracle@acme.test', totpSecret: TOTP_SECRET });
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

test('(e) S2a: a real admin session does not make a tenant host an admin surface', async () => {
  // The regression E-2 exists for, measured with the strongest witness available
  // now that S2a lands: a *valid* `__Host-sk-sess` cookie and an admin path, on a
  // tenant host. §9.1 rule 1 says a public listener does not even parse the cookie,
  // so the answer must be the same 404 as any unmatched path — and the session row
  // must not have been touched by the attempt.
  const { cookie } = await openSession({ port, key: 'acme', email: 'oracle@acme.test' });

  const expiredBefore = sessionExpiry(fixture.controlDb, cookie);
  const adminish = await call({
    port,
    path: '/admin/t/acme/pages',
    host: 'acme.test',
    headers: { cookie },
  });
  const unknown = await call({ port, path: '/no-such-page', host: 'acme.test', headers: { cookie } });

  assert.equal(adminish.status, 404);
  assert.equal((adminish.json as { error: { code: string } }).error.code, 'SKW_E_RT_PAGE_NOT_FOUND');
  assert.equal(adminish.headers['set-cookie'], undefined);
  assert.equal(scrub(adminish), scrub(unknown), 'byte-identical to any unmatched path, cookie and all');
  assert.equal(
    sessionExpiry(fixture.controlDb, cookie),
    expiredBefore,
    'a public listener must not parse the session cookie: the row was not touched',
  );

  // And the same cookie is a session on the admin host, so the row above is not
  // simply an invalid cookie.
  const onAdmin = await call({ port, path: '/admin/t/acme/session', host: ADMIN_HOST, headers: { cookie } });
  assert.equal(onAdmin.status, 200);

  // The sharpest form of the same rule: a *login* with real credentials, sent to a
  // tenant host, must not mint a session. If the path could select the admin
  // surface this would be a 200 with a `Set-Cookie` on the tenant's own origin —
  // which is B1 with an attacker holding the credentials.
  const loginOnTenant = await call({
    port,
    path: '/admin/t/acme/login',
    method: 'POST',
    host: 'acme.test',
    headers: { 'content-type': 'application/json', origin: 'https://admin.skw.test' },
    body: JSON.stringify({ email: 'oracle@acme.test', password: 'correct-horse-battery-staple' }),
  });
  assert.equal(loginOnTenant.status, 404);
  assert.equal((loginOnTenant.json as { error: { code: string } }).error.code, 'SKW_E_RT_PAGE_NOT_FOUND');
  assert.equal(loginOnTenant.headers['set-cookie'], undefined, 'a tenant host must never mint an admin session');
});

/** `expires_at` of the session behind a cookie, read from a second connection. */
function sessionExpiry(controlDb: string, cookie: string): string | null {
  const value = cookie.slice(cookie.indexOf('=') + 1);
  const id = value.split('.')[0] ?? '';
  const db = new Database(controlDb, { readonly: true });
  try {
    const row = db.prepare('SELECT expires_at FROM session WHERE id = ?').get(id) as
      | { expires_at: string }
      | undefined;
    return row?.expires_at ?? null;
  } finally {
    db.close();
  }
}
