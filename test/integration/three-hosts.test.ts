/**
 * §16 S1 gate: "GET /pricing on a mapped host renders the tenant's page —
 * integration test, 3 hosts".
 *
 * Three Host headers, one process, one Astro mount. The assertions are about
 * which cms_page row came back, not about a 200.
 *
 * **D37 added the admin half of "one box, three hosts":** `/admin` is on every
 * tenant host, so two tenants that share this box also share a browser and an origin
 * shape. The last four tests are the property the old separate `admin.<domain>`
 * hostname used to give for free — one email, two tenants, two independent sessions —
 * and they live in this file because this is the file about one process and three
 * hosts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

import { buildApp, type AppHandle } from '../../app/main.ts';
import { loadEnv } from '../../app/env.ts';
import { ADMIN_COOKIE_PATH, SESSION_COOKIE_PREFIX, sessionCookieName } from '../../app/admin/session.ts';
import {
  PASSWORD,
  TOTP_SECRET,
  cookiePair,
  currentTotp,
  seedUser,
  setCookie,
} from '../helpers/admin.ts';
import { makeFixture, type Fixture } from '../helpers/fixture.ts';
import { call, postRaw, type Res } from '../helpers/http.ts';

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

// --- D37: two tenants on one box, one email address, two independent sessions ---
//
// This is the property the separate `admin.<domain>` hostname used to give for free.
// Before D37 the admin lived on its own host, so a tenant's own hostname could not
// reach it (§9.1 rule 1, E-2). The user overruled D9: admin is now `/admin` on **each
// tenant host**, WordPress-style, so two tenants that share a box also share a browser
// and an origin *shape*. What replaces the hostname is asserted here: the Host picks the
// tenant, the cookie is named for that tenant and scoped to `/admin`, and a cookie
// minted on one host is refused on the other — by name, and again by the session row
// when the name is forged.
//
// `acme.test` / `beta.test` are the same two independent hosts the box serves as
// `abc123.com` / `123abc.com`: the names differ, the property does not.

/** The same string on both hosts: `UNIQUE(tenant_id, email)` permits it. */
const SHARED_EMAIL = 'owner@shared.test';

before(async () => {
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: SHARED_EMAIL, totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'beta', email: SHARED_EMAIL, totpSecret: TOTP_SECRET });
});

/** The one login URL, on the host whose tenant is meant. */
async function loginOn(host: string): Promise<Res> {
  return call({
    port,
    path: '/admin/login',
    method: 'POST',
    host,
    headers: { origin: `https://${host}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: SHARED_EMAIL, password: PASSWORD, totp: currentTotp() }),
  });
}

test('D37 (1) — one email on two tenants authenticates on each host, and only there', async () => {
  const onAcme = await loginOn('acme.test');
  assert.equal(onAcme.status, 200, `acme login: ${onAcme.body}`);
  assert.equal((onAcme.json as { tenant?: { key?: string } }).tenant?.key, 'acme');

  const onBeta = await loginOn('beta.test');
  assert.equal(onBeta.status, 200, `beta login: ${onBeta.body}`);
  assert.equal((onBeta.json as { tenant?: { key?: string } }).tenant?.key, 'beta');

  // Two rows, two tenants, one email — and the Host is the only thing that chose
  // between them. A 401 here would mean the Host did not scope the lookup.
  const ids = [onAcme, onBeta].map((res) => {
    const cookie = cookiePair(res) as string;
    return cookie.slice(cookie.indexOf('=') + 1).split('.')[0] as string;
  });
  assert.notEqual(ids[0], ids[1], 'two independent sessions, not one session served twice');
  const db = new Database(fixture.controlDb, { readonly: true });
  try {
    const rows = db
      .prepare('SELECT tenant_id FROM session WHERE id IN (?, ?) ORDER BY tenant_id')
      .all(ids[0] as string, ids[1] as string) as { tenant_id: number }[];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => Number(r.tenant_id)), [1, 2], 'one session row per tenant');
  } finally {
    db.close();
  }
});

test('D37 (2) — the cookie carries the hardening: per-host name, Path=/admin, HttpOnly, Secure, SameSite=Strict', async () => {
  for (const [host, key] of [['acme.test', 'acme'], ['beta.test', 'beta']] as [string, string][]) {
    const res = await loginOn(host);
    assert.equal(res.status, 200, res.body);
    const raw = setCookie(res) as string;
    assert.ok(
      raw.startsWith(`${sessionCookieName(key)}=`),
      `${host} must set ${sessionCookieName(key)}, got ${raw.slice(0, 60)}`,
    );
    const lower = raw.toLowerCase();
    for (const flag of ['httponly', 'secure', 'samesite=strict', `path=${ADMIN_COOKIE_PATH}`]) {
      assert.ok(lower.includes(flag), `${host} cookie is missing ${flag}: ${raw}`);
    }
    // `__Host-` is unavailable at Path=/admin (§7.4.3's erratum is the same rule), so the
    // name is `__Secure-` and the scope is the path. A `Domain=` here would let one tenant
    // host read another's cookie; the prefix forbids it and so does the generator.
    assert.ok(!raw.startsWith('__Host-'), 'a __Host- cookie may not carry Path=/admin');
    assert.doesNotMatch(raw, /Domain=/i, 'a Domain attribute would cross the host boundary');
    // The name comes from the tenant key, not the host string: an alias and the primary
    // share one namespace, two tenants never do.
    assert.equal(sessionCookieName(key), `${SESSION_COOKIE_PREFIX}${key}`);
  }
});

test('D37 (3) — neither host accepts the other host\'s session cookie', async () => {
  const acme = await loginOn('acme.test');
  const beta = await loginOn('beta.test');
  const acmeCookie = cookiePair(acme) as string;
  const betaCookie = cookiePair(beta) as string;

  // A browser would not send acme's cookie to beta at all (host-only cookies), so this
  // is the *strongest* form: the raw header, exactly as a compromised proxy or a shared
  // parent domain would deliver it.
  const acmeOnBeta = await call({ port, path: '/admin/t/beta/session', host: 'beta.test', headers: { cookie: acmeCookie } });
  assert.equal(acmeOnBeta.status, 404, `acme's cookie on beta: ${acmeOnBeta.body}`);
  assert.equal((acmeOnBeta.json as { error?: { code?: string } }).error?.code, 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(setCookie(acmeOnBeta), undefined, 'a refused cookie must not be re-minted');

  const betaOnAcme = await call({ port, path: '/admin/t/acme/session', host: 'acme.test', headers: { cookie: betaCookie } });
  assert.equal(betaOnAcme.status, 404, `beta's cookie on acme: ${betaOnAcme.body}`);
  assert.equal((betaOnAcme.json as { error?: { code?: string } }).error?.code, 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(setCookie(betaOnAcme), undefined);

  // The forged name: the caller rewrites `__Secure-sk-sess-acme` to
  // `__Secure-sk-sess-beta`. The HMAC still verifies (the key is process-wide), so the
  // refusal that has to hold here is the session row's tenant against the Host's.
  const value = acmeCookie.slice(acmeCookie.indexOf('=') + 1);
  const renamed = `${sessionCookieName('beta')}=${value}`;
  const forged = await call({ port, path: '/admin/t/beta/session', host: 'beta.test', headers: { cookie: renamed } });
  assert.equal(forged.status, 404, `a renamed acme cookie on beta: ${forged.body}`);
  assert.equal((forged.json as { error?: { code?: string } }).error?.code, 'SKW_E_PLT_TENANT_UNKNOWN');

  // Neither attempt killed the sessions: independence is not "revoke on contact".
  const acmeStill = await call({ port, path: '/admin/t/acme/session', host: 'acme.test', headers: { cookie: acmeCookie } });
  assert.equal(acmeStill.status, 200, acmeStill.body);
  const betaStill = await call({ port, path: '/admin/t/beta/session', host: 'beta.test', headers: { cookie: betaCookie } });
  assert.equal(betaStill.status, 200, betaStill.body);
});

test('D37 (4) — /admin on a host is that host\'s tenant admin; the URL key cannot override the Host', async () => {
  const acme = await loginOn('acme.test');
  const cookie = cookiePair(acme) as string;
  const own = await call({ port, path: '/admin', host: 'acme.test', headers: { cookie } });
  assert.equal(own.status, 200, own.body);
  assert.ok(own.body.includes('/admin/t/acme/'), "the tenant home is this host's tenant");

  // Acme's session asking for beta's deep URL on acme's host: the key is a claim and the
  // Host is the resolution (§5.3's rule, unchanged by D37).
  const crossed = await call({ port, path: '/admin/t/beta/pages', host: 'acme.test', headers: { cookie } });
  assert.equal(crossed.status, 404, crossed.body);
  assert.equal((crossed.json as { error?: { code?: string } }).error?.code, 'SKW_E_PLT_TENANT_UNKNOWN');
});
