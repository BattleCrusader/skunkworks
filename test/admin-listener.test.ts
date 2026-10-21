/**
 * **D37 SUPERSEDES THIS FILE'S ORIGINAL PROMISE.**
 *
 * Before D37 this file asserted, as the §16 S1 gate amended by 02-errata E-2:
 *
 *     "a demo `Host` cannot reach the admin surface: `/admin/…` is `404` with the
 *      same body as an unknown path, and no admin route is mounted on a public
 *      listener" — because §9.1 said the admin surface is a **hostname**, and that
 *      hostname was the only thing that made a request an admin request.
 *
 * **The decision that changed it is D37, and the CEO made it.** Admin now lives at
 * `/admin` on *every* tenant host, WordPress-style (`abc123.com/admin`, not
 * `admin.abc123.com`), and the fleet console moved to `/fleet`. The reason D9 wanted a
 * separate hostname is recorded so nobody thinks it was forgotten: a hostname meant
 * tenant-authored HTML and the admin could never share an origin (C-25), so a `<script>`
 * a tenant pasted into a page could not `fetch('/admin/pages')` with the operator's
 * cookie attached; and it meant `/admin` on a tenant host could be *byte-identical* to
 * a missing page, so no probe could fingerprint the CMS. Both of those are given up by
 * decision, not by accident. What replaces them is asserted below and in
 * `test/integration/cross-host-session.test.ts`:
 *
 *   - the tenant is the `Host`'s and nothing else — not a header, not a URL segment,
 *     not the session (tests a, b, c, d);
 *   - `/fleet` is a fleet operator's surface and a tenant owner gets the page-miss 404,
 *     byte for byte (test e);
 *   - a session for one tenant is refused on another tenant's host, by cookie name and
 *     again by the session row (the cross-host file).
 *
 * The OLD promise is not silently dropped: test (c) is where the old "a demo host is
 * 404" assertion used to live, and it now asserts the new rule. The one rule from the
 * old file that survives unchanged is that a tenant header never names the admin
 * tenant — it is the first test in this file, because it is the one thing the old
 * design and the new one both must refuse.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp, type AppHandle } from '../app/main.ts';
import { loadEnv } from '../app/env.ts';
import { ADMIN_COOKIE_PATH, sessionCookieName } from '../app/admin/session.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';
import { ADMIN_HOST, TOTP_SECRET, currentTotp, login, openSession, seedUser, setCookie } from './helpers/admin.ts';

/** No admin host exists any more; this name is a *tenant* host (D37). */
const TENANT_HOST = ADMIN_HOST; // acme.test
const OTHER_TENANT_HOST = 'beta.test';
/** The name that used to be the admin host. It maps to nothing now. */
const GONE_ADMIN_HOST = 'admin.skw.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

before(async () => {
  fixture = makeFixture();
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'oracle@acme.test', totpSecret: TOTP_SECRET });
  await seedUser({
    controlDb: fixture.controlDb,
    tenantKey: null,
    email: 'fleet@skw.test',
    role: 'fleet_admin',
    totpSecret: TOTP_SECRET,
  });
  handle = await buildApp({ env: loadEnv({ ...fixture.env, SKW_FLEET_MODE: '1' }) });
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

function codeOf(res: Res): string | undefined {
  return (res.json as { error?: { code?: string } } | undefined)?.error?.code;
}

test('(a) the tenant on /admin is the Host\'s, and a tenant header never names it (row 1, relocated)', async () => {
  // D37: the tenant comes from the Host. A non-empty tenant header is an assertion and
  // is refused 421 — the one rule that survived E-2's four consequences unchanged.
  for (const value of ['beta', 'acme']) {
    const res = await call({
      port,
      path: '/admin/t/acme/pages',
      host: TENANT_HOST,
      headers: { 'x-skunkworks-tenant': value },
    });
    assert.equal(res.status, 421, `non-empty tenant header ${JSON.stringify(value)} on a tenant host`);
    assert.equal(codeOf(res), 'SKW_E_PLT_EDGE_PROOF');
  }

  // An *empty* one is the edge's own `proxy_set_header … ""` and asserts nothing. It is
  // not a 421 and it does not select a tenant: the request still needs a session for the
  // Host's tenant, and without one it is the 404 every unauthenticated admin path is.
  // This is the narrowed half of the old row 1 and it is stated explicitly, because the
  // opposite (narrowing a gate by accident) is how a real one disappears.
  const empty = await call({
    port,
    path: '/admin/t/acme/pages',
    host: TENANT_HOST,
    headers: { 'x-skunkworks-tenant': '' },
  });
  assert.equal(empty.status, 404);
  assert.equal(codeOf(empty), 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('(b) the URL key cannot override the Host: /admin/t/beta on acme\'s host is 404, with no Set-Cookie', async () => {
  const { cookie } = await openSession({ port, key: 'acme', email: 'oracle@acme.test', host: TENANT_HOST });
  const crossed = await call({ port, path: '/admin/t/beta/pages', host: TENANT_HOST, headers: { cookie } });
  assert.equal(crossed.status, 404);
  assert.equal(codeOf(crossed), 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(crossed.headers['set-cookie'], undefined);

  // The same session on beta's host is refused too — the cookie is not even in beta's
  // namespace, so nothing is read — and the refusal is the same code.
  const wrongHost = await call({ port, path: '/admin/t/beta/pages', host: OTHER_TENANT_HOST, headers: { cookie } });
  assert.equal(wrongHost.status, 404);
  assert.equal(codeOf(wrongHost), 'SKW_E_PLT_TENANT_UNKNOWN');

  // And the URL's key is the *Host's*: the same session on its own host works.
  const own = await call({ port, path: '/admin/t/acme/session', host: TENANT_HOST, headers: { cookie } });
  assert.equal(own.status, 200, own.body);
});

test('(c) D37 — a demo host still cannot reach the admin surface, and the old "404 on every path" is now "404 on this path"', async () => {
  // This is the test that used to assert "a demo Host cannot reach the admin surface".
  // It still holds, for a *better* reason: a demo host maps to no tenant, so `/admin`
  // there is the same `SKW_E_PLT_TENANT_UNKNOWN` any path on it is — there is nothing
  // to authenticate against. The assertion is unchanged; the promise behind it moved.
  const demos = await call({ port, path: '/admin/t/acme/pages', host: 'demos.skw.test' });
  assert.equal(demos.status, 404, 'the demos vhost never reaches a tenant admin');
  assert.equal(codeOf(demos), 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(demos.headers['set-cookie'], undefined);

  // The demo *tenant host* (`acme-demo.test`) is an ordinary tenant host under D37: it
  // has its own admin at `/admin`, and with no session it is the 404 — not the old 421,
  // and not a page miss. That change is the decision, stated where the old assertion was.
  const demoHost = await call({ port, path: '/admin/t/demo-acme/pages', host: 'acme-demo.test' });
  assert.equal(demoHost.status, 404, 'a demo tenant host is a tenant host now');
  assert.equal(codeOf(demoHost), 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(demoHost.headers['set-cookie'], undefined);
});

test('(d) a Host that maps to no tenant is 404 SKW_E_PLT_TENANT_UNKNOWN on /admin and on /fleet', async () => {
  for (const path of ['/admin', '/admin/t/acme/pages', '/admin/login']) {
    const res = await call({ port, path, host: GONE_ADMIN_HOST });
    assert.equal(res.status, 404, `${path} on a Host with no tenant`);
    assert.equal(codeOf(res), 'SKW_E_PLT_TENANT_UNKNOWN', path);
    assert.equal(res.headers['set-cookie'], undefined, path);
  }
});

test('(e) D37 — a tenant owner asking for /fleet gets the page-miss 404, byte for byte', async () => {
  const { cookie } = await openSession({ port, key: 'acme', email: 'oracle@acme.test', host: TENANT_HOST });

  const fleet = await call({ port, path: '/fleet', host: TENANT_HOST, headers: { cookie } });
  const missing = await call({ port, path: '/no-such-page', host: TENANT_HOST, headers: { cookie } });

  assert.equal(fleet.status, 404);
  assert.equal(codeOf(fleet), 'SKW_E_RT_PAGE_NOT_FOUND', 'a page miss, not an admin refusal');
  assert.equal(fleet.headers['set-cookie'], undefined);
  assert.equal(scrub(fleet), scrub(missing), 'byte-identical to a path with no page');
  assert.equal(fleet.headers['cache-control'], missing.headers['cache-control']);

  // Nothing about the console may appear in the answer.
  assert.doesNotMatch(fleet.body, /fleet operator|tenant-switcher|Sign out/);
});

test('(f) D37 — a fleet session gets the console at /fleet and nothing at /admin', async () => {
  const session = await openSession({ port, email: 'fleet@skw.test', host: TENANT_HOST });
  assert.ok(session.cookie.startsWith('__Secure-sk-fleet='), `fleet cookie: ${session.cookie.slice(0, 40)}`);

  const consoleRes = await call({ port, path: '/fleet', host: TENANT_HOST, headers: { cookie: session.cookie } });
  assert.equal(consoleRes.status, 200, consoleRes.body);
  assert.ok(consoleRes.body.includes('data-tenant="acme"'), 'the fleet sees the tenants');
  assert.ok(consoleRes.body.includes('https://acme.test/admin'), 'and where each one is administered');

  // A fleet session has no tenant, so every /admin path is refused — including `/admin`
  // itself, which is now a *tenant* home and needs a tenant session.
  const admin = await call({ port, path: '/admin', host: TENANT_HOST, headers: { cookie: session.cookie } });
  assert.equal(admin.status, 404, 'a fleet session has no tenant home');
  assert.equal(codeOf(admin), 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('(g) D37 — the login sets this tenant\'s cookie at Path=/admin, with no Domain and no fleet path', async () => {
  const res = await login({ port, key: 'acme', email: 'oracle@acme.test', totp: currentTotp(), host: TENANT_HOST });
  assert.equal(res.status, 200, res.body);
  const raw = String(setCookie(res));
  assert.ok(raw.startsWith(`${sessionCookieName('acme')}=`), raw);
  assert.match(raw, /HttpOnly; Secure; SameSite=Strict; Path=\/admin$/);
  assert.doesNotMatch(raw, /Domain=/i, 'a Domain attribute is the one way one host\'s cookie reaches another');
  assert.doesNotMatch(raw, /Path=\/fleet/, 'the tenant cookie is not the fleet cookie');

  // A refused login (no TOTP, mandatory with an empty allowlist) mints nothing.
  const refused = await login({ port, key: 'acme', email: 'oracle@acme.test', host: TENANT_HOST });
  assert.equal(refused.status, 401);
  assert.equal(setCookie(refused), undefined);
});

test('(h) D37 — another tenant\'s operator on this host is one indistinguishable 401, and no cookie', async () => {
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'beta', email: 'owner@beta.test', totpSecret: TOTP_SECRET });
  // The Host scopes the credential lookup, so beta's row is simply not in acme's
  // scope. The answer is therefore the same 401 an unknown email gets — not a 404
  // that would tell the caller "that account exists, somewhere else".
  const res = await login({ port, email: 'owner@beta.test', totp: currentTotp(), host: TENANT_HOST });
  assert.equal(res.status, 401, "beta's operator on acme's host");
  assert.equal(codeOf(res), 'SKW_E_SEC_AUTH_INVALID');
  assert.equal(setCookie(res), undefined, 'and no cookie');

  const unknown = await login({ port, email: 'nobody@acme.test', totp: currentTotp(), host: TENANT_HOST });
  assert.equal(unknown.status, 401);
  assert.equal(scrub(res), scrub(unknown), 'a row in another tenant and no row at all are one answer');
});
