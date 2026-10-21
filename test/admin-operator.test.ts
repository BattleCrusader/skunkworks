/**
 * S2b — the operator lifecycle and the fleet console.
 *
 *   E-19 item 2   TOTP enrolment + confirm for a second operator, and
 *                 `skwctl admin reset-totp` over box shell access.
 *   E-19 item 3   password reset over `reset_token_hash` / `reset_expires_at`.
 *   D29           every tenant URL is `/admin/t/<key>/…` and login is `/admin/login`.
 *                 **D37 replaced D29's console**: `GET /admin` is now the *Host's*
 *                 tenant home, `/admin/t/<key>/` must match the Host, and the fleet
 *                 console is `GET /fleet`. The switcher's promise changed shape —
 *                 selecting a tenant means selecting its host, not its URL — and the
 *                 tests below say so where the old ones did.
 *   §9.3          the first CRUD read path for a `cms_*` table (list + detail),
 *                 on the `render-read` connection class.
 *
 * Every request goes over a socket to the real app; the only seam is the fixture's
 * `control.db`, which is where an operator row actually lives.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { totpCode, verifyTotp } from '../app/admin/auth.ts';
import { FLEET_COOKIE, sessionCookieName } from '../app/admin/session.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import {
  ADMIN_HOST,
  ADMIN_ORIGIN,
  PASSWORD,
  TOTP_SECRET,
  codeOf,
  cookiePair,
  currentTotp,
  login,
  openSession,
  seedUser,
  type Sessioned,
} from './helpers/admin.ts';
import { makeFixture, REPO, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

let fleet: Fixture;
let fleetHandle: AppHandle;
let fleetPort = 0;

function listen(app: AppHandle): Promise<number> {
  return app.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = app.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
}

function idOf(cookie: string): string {
  // D37: the name is the tenant's, so the id starts after that tenant's prefix.
  const eq = cookie.indexOf('=');
  return cookie.slice(eq + 1).split('.')[0] as string;
}

function sessionRow(id: string): { tenant_id: number | null; revoked_at: string | null } {
  const db = new Database(fixture.controlDb, { readonly: true });
  const row = db.prepare('SELECT tenant_id, revoked_at FROM session WHERE id = ?').get(id) as
    | { tenant_id: number | null; revoked_at: string | null }
    | undefined;
  db.close();
  if (row === undefined) throw new Error(`no session ${id}`);
  return row;
}

function post(path: string, session: Sessioned, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {
    cookie: session.cookie,
    origin: ADMIN_ORIGIN,
    'x-csrf-token': session.csrfToken,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return call({
    port,
    path,
    method: 'POST',
    host: ADMIN_HOST,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

before(async () => {
  fixture = makeFixture();
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'second@acme.test', role: 'editor', totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'reset@acme.test', totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'reset2@acme.test', totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'rotate@acme.test', totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await listen(handle);

  // A fleet operator (`tenant_id IS NULL`) needs SKW_FLEET_MODE=1.
  fleet = makeFixture();
  await seedUser({ controlDb: fleet.controlDb, tenantKey: null, email: 'fleet@skw.test', role: 'fleet_admin', totpSecret: TOTP_SECRET });
  fleetHandle = await buildApp({ env: loadEnv({ ...fleet.env, SKW_FLEET_MODE: '1' }) });
  fleetPort = await listen(fleetHandle);
});

after(async () => {
  await handle.close();
  fixture.cleanup();
  await fleetHandle.close();
  fleet.cleanup();
});

// --- D29: the console, the switcher, the one login URL ----------------------

// S8a / E-34 — REWRITTEN, not deleted. `/admin` used to answer the row-7 404, which is the
// right answer for an unauthenticated *API* request and the wrong one for the address every
// operator is told to visit: it left the front door indistinguishable from a missing page.
// It now redirects to `/admin/login`, which this Host already serves at 200 — so the redirect
// itself reveals nothing that a browser could not have seen by asking for the login page.
// The property row 7 protects is asserted below on a path where it still matters.
test('D37-1. GET /admin with no session redirects to the login page', async () => {
  const res = await call({ port, path: '/admin', host: ADMIN_HOST });
  assert.equal(res.status, 302);
  assert.equal(header(res, 'location'), '/admin/login');
  assert.equal(String(header(res, 'cache-control')), 'no-store');
  // No session is minted by looking at the door.
  assert.equal(header(res, 'set-cookie'), undefined);
});

test('D37-1b. an unauthenticated tenant-scoped admin path is still the row-7 404, not a redirect', async () => {
  // This is the rule E-34 does not touch: a JSON read with no session reports "no tenant
  // here", never 401/403, and never a redirect that confirms the endpoint exists.
  for (const path of ['/admin/t/acme/pages', '/admin/t/acme/session', '/admin/api/tenants/acme/health']) {
    const res = await call({ port, path, host: ADMIN_HOST });
    assert.equal(res.status, 404, `${path} answered ${res.status}`);
    assert.equal(codeOf(res), 'SKW_E_PLT_TENANT_UNKNOWN', path);
    assert.equal(header(res, 'location'), undefined, `${path} must not redirect`);
  }
});

test('D37-2. /admin is this Host\'s tenant home: their own pages, and no fleet inventory', async () => {
  const session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
  const res = await call({ port, path: '/admin', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(res.status, 200, res.body);
  assert.match(String(header(res, 'content-type')), /text\/html/);
  assert.match(String(header(res, 'cache-control')), /no-store/);
  // S7 NOTE — RE-POINTED, not deleted. The Guided Cards app bar names the three screens a
  // site owner uses; `/admin/t/<key>/pages` is the JSON read (S3's contract) and the human
  // page list is `/admin` itself, so the menu no longer links the JSON endpoint. The
  // property this test is about — the menu is *this tenant's* — is asserted on the same
  // menu with the screen the operator actually lands on, and the media screen beside it.
  assert.ok(res.body.includes('href="/admin/t/acme/" aria-current="page">Pages'), "the tenant's own menu");
  assert.ok(res.body.includes('href="/admin/t/acme/media"'), "the tenant's own media screen");
  assert.equal(res.body.includes('/admin/t/beta/'), false, 'a tenant operator does not see the fleet inventory');
  assert.ok(res.body.includes('owner@acme.test'));
  // D29's "All tenants" entry was the fleet console. It is `/fleet` now and a tenant
  // owner gets the page-miss 404 there, so a menu must not offer it.
  assert.equal(res.body.includes('All tenants'), false, 'no link to a surface that 404s for this operator');
});

test('D37-3. the tenant URL is the Host\'s; the session row tenant is never rewritten', async () => {
  const session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
  const id = idOf(session.cookie);
  const before = sessionRow(id).tenant_id;

  const home = await call({ port, path: '/admin/t/acme/', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(home.status, 200, home.body);
  assert.ok(home.body.includes('acme'));
  assert.equal(sessionRow(id).tenant_id, before, 'a request never changes which tenant the session names');
});

test('D29-4. another tenant\'s /admin/t/<key>/… is refused for a non-fleet operator', async () => {
  const session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
  const id = idOf(session.cookie);
  for (const path of ['/admin/t/beta/', '/admin/t/beta/session', '/admin/t/beta/pages']) {
    const res = await call({ port, path, host: ADMIN_HOST, headers: { cookie: session.cookie } });
    assert.equal(res.status, 404, path);
    assert.equal(codeOf(res), 'SKW_E_PLT_TENANT_UNKNOWN', path);
    assert.equal(header(res, 'set-cookie'), undefined, path);
  }
  assert.equal(sessionRow(id).revoked_at, null, 'a refused cross-tenant request does not kill the session');
});

test('D37-5. a fleet operator reaches /fleet and no tenant URL', async () => {
  const session = await openSession({ port: fleetPort, email: 'fleet@skw.test' });
  assert.ok(session.cookie.startsWith(`${FLEET_COOKIE}=`), 'the fleet session gets the fleet cookie');
  const consoleRes = await call({ port: fleetPort, path: '/fleet', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(consoleRes.status, 200, consoleRes.body);
  assert.ok(consoleRes.body.includes('data-tenant="acme"'), 'the fleet sees every active tenant');
  assert.ok(consoleRes.body.includes('data-tenant="beta"'));
  assert.ok(consoleRes.body.includes('fleet operator'));
  // D37: the console cannot link a fleet session into a tenant admin (there is no
  // tenant to be), so each entry carries the tenant's own admin address instead.
  assert.ok(consoleRes.body.includes('https://acme.test/admin'), 'and where each tenant is administered');

  const tenantUrl = await call({ port: fleetPort, path: '/admin/t/acme/', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(tenantUrl.status, 404, 'a fleet session has no tenant, so every tenant URL is refused');
  assert.equal(codeOf(tenantUrl), 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('D29-6. /admin/login is the only login URL: a page for GET, a real form post for POST', async () => {
  const pageRes = await call({ port, path: '/admin/login', host: ADMIN_HOST });
  assert.equal(pageRes.status, 200);
  assert.match(String(header(pageRes, 'content-type')), /text\/html/);
  assert.ok(pageRes.body.includes('action="/admin/login"'));

  // A plain HTML form post: urlencoded, no JavaScript, and no CSRF form field
  // (D28 — the token is a header, and login has no session to bind one to).
  const form = new URLSearchParams({
    email: 'owner@acme.test',
    password: 'correct-horse-battery-staple',
    totp: currentTotp(),
  }).toString();
  const res = await call({
    port,
    path: '/admin/login',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  assert.equal(res.status, 200, res.body);
  const pair = cookiePair(res) as string;
  assert.ok(pair.startsWith(`${sessionCookieName('acme')}=`), `D37 names the cookie for the tenant: ${pair.slice(0, 40)}`);

  // The per-tenant login is gone: it would select a tenant from the URL.
  const perTenant = await call({
    port,
    path: '/admin/t/acme/login',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@acme.test', password: 'correct-horse-battery-staple', totp: currentTotp() }),
  });
  assert.equal(perTenant.status, 404);
  assert.equal(codeOf(perTenant), 'SKW_E_PLT_TENANT_UNKNOWN');
});

/**
 * S8f. The sign-in form is a plain HTML form with no JavaScript, so the *browser* is the
 * client that posts it. A response body is a document to a browser: answering a successful
 * sign-in with the JSON session record left the operator staring at one line of JSON on
 * `/admin/login` with no way forward. The rule is the HTTP one — a form POST that is
 * accepted ends in `303` and a `Location`, and the `Set-Cookie` rides on that reply.
 */
test('D29-6b. a browser form post signs in and answers with a redirect, not a JSON body', async () => {
  const form = new URLSearchParams({
    email: 'owner@acme.test',
    password: PASSWORD,
    totp: currentTotp(),
  }).toString();
  const res = await call({
    port,
    path: '/admin/login',
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      origin: ADMIN_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    body: form,
  });
  assert.equal(res.status, 303, res.body);
  assert.equal(header(res, 'location'), '/admin');
  // A browser that did get a body would render it; a redirect carries none.
  assert.equal(res.body, '');
  const pair = cookiePair(res) as string;
  assert.ok(pair.startsWith(`${sessionCookieName('acme')}=`), `the cookie rides on the redirect: ${pair.slice(0, 40)}`);
  // The redirect target is a real page for the session it just minted.
  const portal = await call({ port, path: '/admin', host: ADMIN_HOST, headers: { cookie: pair } });
  assert.equal(portal.status, 200);
  assert.match(portal.body, /Your pages/);
});

test('D29-6c. a ?next= inside the console survives the post, and one outside it does not', async () => {
  const signIn = (next: string): Promise<Res> =>
    call({
      port,
      path: '/admin/login',
      method: 'POST',
      host: ADMIN_HOST,
      headers: {
        origin: ADMIN_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
      },
      body: new URLSearchParams({
        email: 'owner@acme.test',
        password: PASSWORD,
        totp: currentTotp(),
        next,
      }).toString(),
    });

  const wanted = '/admin/t/acme/editor?page=2';
  assert.equal(header(await signIn(wanted), 'location'), wanted);

  // A query parameter is attacker-controlled: only the console's own paths are honoured.
  for (const hostile of ['https://evil.test/x', '//evil.test/x', '/etc/passwd', '/admin/login', '\\\\evil.test']) {
    assert.equal(
      header(await signIn(hostile), 'location'),
      '/admin',
      `${JSON.stringify(hostile)} must not become the destination`,
    );
  }
});

test('D29-6d. a failed browser sign-in gets the form back with one sentence, and no cookie', async () => {
  const res = await call({
    port,
    path: '/admin/login',
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      origin: ADMIN_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
    },
    body: new URLSearchParams({
      email: 'owner@acme.test',
      password: 'not-the-password-at-all',
      totp: currentTotp(),
    }).toString(),
  });
  assert.equal(res.status, 401);
  assert.match(String(header(res, 'content-type')), /text\/html/);
  assert.equal(header(res, 'set-cookie'), undefined, 'a failed attempt mints nothing');
  assert.ok(res.body.includes('action="/admin/login"'), 'the form is back, ready for another try');
  assert.ok(res.body.includes('did not match'), 'and it says what happened');
  // E-16 survives: the sentence does not say *which* factor was wrong.
  assert.ok(!/password was wrong|no such user|wrong code/i.test(res.body));
});
test('D28. the CSRF token is a header and there is no form-field alternative', async () => {
  const session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
  const asField = await call({
    port,
    path: '/admin/t/acme/session/rotate',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { cookie: session.cookie, origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: `csrfToken=${encodeURIComponent(session.csrfToken)}&_csrf=${encodeURIComponent(session.csrfToken)}`,
  });
  assert.equal(asField.status, 403, 'a form field is not a token');
  assert.equal(codeOf(asField), 'SKW_E_SEC_CSRF');

  const asHeader = await post('/admin/t/acme/session/rotate', session);
  assert.equal(asHeader.status, 200, asHeader.body);
});

// --- E-19 item 2: enrolment for a second operator --------------------------

test('E19-2a. enrolment hands out a secret that is not written until a code proves it', async () => {
  const session = await openSession({ port, key: 'acme', email: 'second@acme.test' });
  const before = (() => {
    const db = new Database(fixture.controlDb, { readonly: true });
    const row = db.prepare('SELECT totp_secret FROM user_account WHERE email = ?').get('second@acme.test') as {
      totp_secret: string;
    };
    db.close();
    return row.totp_secret;
  })();

  const enrol = await post('/admin/t/acme/totp/enrol', session);
  assert.equal(enrol.status, 200, enrol.body);
  const json = enrol.json as { secret: string; otpauthUri: string; groups: string };
  assert.match(json.secret, /^[A-Z2-7]{32}$/, '20 bytes as unpadded base32');
  assert.equal(json.otpauthUri.includes(`secret=${json.secret}`), true);
  assert.equal(json.groups.includes(' '), true, 'grouped for a human');
  assert.notEqual(json.secret, before);

  const db = new Database(fixture.controlDb, { readonly: true });
  const after = db.prepare('SELECT totp_secret FROM user_account WHERE email = ?').get('second@acme.test') as {
    totp_secret: string;
  };
  db.close();
  assert.equal(after.totp_secret, before, 'a pending enrolment has not touched the row');

  // A wrong code is refused and leaves the row alone.
  const wrong = await post('/admin/t/acme/totp/confirm', session, { code: '000000' });
  assert.equal(wrong.status, 401);
  assert.equal(codeOf(wrong), 'SKW_E_SEC_AUTH_INVALID');

  // The right code writes it, rotates the session, and the old cookie dies.
  const code = totpCode(json.secret, Date.now());
  const confirm = await post('/admin/t/acme/totp/confirm', session, { code });
  assert.equal(confirm.status, 200, confirm.body);
  const rotated = cookiePair(confirm);
  assert.ok(rotated !== undefined, 'a credential change rotates the session (§9.1)');
  assert.notEqual(rotated, session.cookie);

  const db2 = new Database(fixture.controlDb, { readonly: true });
  const written = db2.prepare('SELECT totp_secret FROM user_account WHERE email = ?').get('second@acme.test') as {
    totp_secret: string;
  };
  db2.close();
  assert.equal(written.totp_secret, json.secret);
  assert.equal(verifyTotp(written.totp_secret, code, Date.now()), true);

  const old = await call({ port, path: '/admin/t/acme/session', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(old.status, 404, 'the pre-enrolment cookie is dead');
  const fresh = await call({ port, path: '/admin/t/acme/session', host: ADMIN_HOST, headers: { cookie: rotated as string } });
  assert.equal(fresh.status, 200);

  // And the new secret is the one the next login needs.
  const relogin = await login({ port, email: 'second@acme.test', totp: totpCode(json.secret, Date.now()) });
  assert.equal(relogin.status, 200, relogin.body);
  const withOld = await login({ port, email: 'second@acme.test', totp: currentTotp() });
  assert.equal(withOld.status, 401, 'the replaced secret no longer authenticates');
});

test('E19-2b. skwctl admin reset-totp replaces the secret and revokes the sessions', async () => {
  const session = await openSession({ port, key: 'acme', email: 'rotate@acme.test' });
  const out = join(fixture.dir, 'rotate-totp.txt');
  const run = spawnSync(
    process.execPath,
    [join(REPO, 'app', 'cli', 'skwctl.ts'), 'admin', 'reset-totp', '--email', 'rotate@acme.test', '--enrolment-out', out],
    { cwd: REPO, env: { ...fixture.env }, encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(out), true);

  const text = readFileSync(out, 'utf8');
  const secret = /^secret:\s+([A-Z2-7 ]+)$/m.exec(text)?.[1]?.replace(/ /g, '') as string;
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.notEqual(secret, TOTP_SECRET);

  const db = new Database(fixture.controlDb, { readonly: true });
  const row = db.prepare('SELECT totp_secret FROM user_account WHERE email = ?').get('rotate@acme.test') as {
    totp_secret: string;
  };
  const audit = db.prepare("SELECT actor_label, action FROM audit_log WHERE action = 'admin.reset_totp'").get() as {
    actor_label: string;
    action: string;
  };
  db.close();
  assert.equal(row.totp_secret, secret);
  assert.equal(audit.actor_label, 'install');

  const dead = await call({ port, path: '/admin/t/acme/session', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(dead.status, 404, 'a factor change revokes every live session');

  const relogin = await login({ port, email: 'rotate@acme.test', totp: totpCode(secret, Date.now()) });
  assert.equal(relogin.status, 200, relogin.body);
});

// --- E-19 item 3: password reset over the two frozen columns ---------------

test('E19-3a. reset request issues a single-use token; consumption changes the password and kills the sessions', async () => {
  const session = await openSession({ port, key: 'acme', email: 'reset@acme.test' });
  const request = await post('/admin/t/acme/password/reset-request', session);
  assert.equal(request.status, 200, request.body);
  const { token, expiresAt } = request.json as { token: string; expiresAt: string };
  assert.ok(token.length >= 32);
  assert.ok(Date.parse(expiresAt) > Date.now());

  // Stored hashed, not in clear.
  const db = new Database(fixture.controlDb, { readonly: true });
  const row = db.prepare('SELECT reset_token_hash, reset_expires_at FROM user_account WHERE email = ?').get('reset@acme.test') as {
    reset_token_hash: string;
    reset_expires_at: string;
  };
  db.close();
  assert.notEqual(row.reset_token_hash, token);
  assert.equal(row.reset_token_hash.length, 64, 'sha256 hex');
  assert.equal(Date.parse(row.reset_expires_at), Date.parse(expiresAt));

  const newPassword = 'a-brand-new-password-1';
  const reset = await call({
    port,
    path: '/admin/password/reset',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ token, new_password: newPassword }),
  });
  assert.equal(reset.status, 200, reset.body);

  const dead = await call({ port, path: '/admin/t/acme/session', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(dead.status, 404, 'every live session of the account dies with the password');

  const oldPassword = await login({ port, email: 'reset@acme.test', totp: currentTotp() });
  assert.equal(oldPassword.status, 401, 'the old password is gone');
  const used = await login({ port, email: 'reset@acme.test', password: newPassword, totp: currentTotp() });
  assert.equal(used.status, 200, used.body);

  // Single use.
  const again = await call({
    port,
    path: '/admin/password/reset',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ token, new_password: 'another-password-here' }),
  });
  assert.equal(again.status, 400);
  assert.equal(codeOf(again), 'SKW_E_PLT_REQUEST_INVALID');
});

test('E19-3b. an expired token, a short password and a wrong Origin are all refused', async () => {
  const session = await openSession({ port, key: 'acme', email: 'reset2@acme.test' });
  const request = await post('/admin/t/acme/password/reset-request', session);
  const { token } = request.json as { token: string };

  const db = new Database(fixture.controlDb);
  db.prepare('UPDATE user_account SET reset_expires_at = ? WHERE email = ?').run(
    new Date(Date.now() - 1_000).toISOString(),
    'reset2@acme.test',
  );
  db.close();

  const expired = await call({
    port,
    path: '/admin/password/reset',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ token, new_password: 'a-long-enough-password' }),
  });
  assert.equal(expired.status, 400, 'an expired token is one answer with an unknown one');

  const short = await call({
    port,
    path: '/admin/password/reset',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ token, new_password: 'short' }),
  });
  assert.equal(short.status, 400);

  const foreign = await call({
    port,
    path: '/admin/password/reset',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: 'https://admin.skw.test.evil.test', 'content-type': 'application/json' },
    body: JSON.stringify({ token, new_password: 'a-long-enough-password' }),
  });
  assert.equal(foreign.status, 403);
  assert.equal(codeOf(foreign), 'SKW_E_SEC_CSRF');
});

// --- §9.3: the first CRUD read path, on render-read ------------------------

test('CRUD-1. GET pages lists this tenant\'s cms_page rows, and the detail is one row', async () => {
  const session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
  const list = await call({ port, path: '/admin/t/acme/pages', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(list.status, 200, list.body);
  const json = list.json as { tenant: string; pages: { id: number; path: string; status: string }[] };
  assert.equal(json.tenant, 'acme');
  assert.equal(json.pages.length, 1);
  assert.equal(json.pages[0]?.path, '/pricing');
  assert.equal(json.pages[0]?.status, 'published');
  assert.match(String(header(list, 'cache-control')), /no-store/);

  const id = json.pages[0]?.id as number;
  const detail = await call({ port, path: `/admin/t/acme/pages/${id}`, host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(detail.status, 200, detail.body);
  const page = (detail.json as { page: { id: number; path: string; title: string; body_html: string } }).page;
  assert.equal(page.id, id);
  assert.equal(page.path, '/pricing');
  assert.ok(page.body_html.includes('Acme pricing'));
});

test('CRUD-2. the list is tenant-scoped: beta\'s page id is not reachable from acme', async () => {
  const session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
  const beta = new Database(fixture.sitePath('beta'), { readonly: true });
  const betaId = (beta.prepare('SELECT id FROM cms_page').get() as { id: number }).id;
  beta.close();
  const acme = new Database(fixture.sitePath('acme'), { readonly: true });
  const acmeId = (acme.prepare('SELECT id FROM cms_page').get() as { id: number }).id;
  acme.close();
  assert.equal(betaId, acmeId, 'both fixtures number their first page 1, which is why the path is what scopes it');

  const detail = await call({ port, path: `/admin/t/acme/pages/${betaId}`, host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(detail.status, 200);
  assert.equal((detail.json as { page: { title: string } }).page.title, 'Acme pricing', 'the acme file, not beta');

  const cross = await call({ port, path: '/admin/t/beta/pages', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(cross.status, 404, 'and beta is not reachable with an acme session at all');

  const missing = await call({ port, path: '/admin/t/acme/pages/999', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(missing.status, 404);
  assert.equal(codeOf(missing), 'SKW_E_RT_PAGE_NOT_FOUND');
});
