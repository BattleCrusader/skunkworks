/**
 * S8a — the admin front door, and the account that stands in front of it.
 *
 * Two promises, both from the operator's side of the glass:
 *
 *   1. **`/admin` is a door, not a dead end.** With no session it answers
 *      `302 -> /admin/login` — the login page is already served at 200 on this very
 *      Host, so the redirect reveals nothing that a browser could not already see.
 *      With a session it answers the page list.
 *   2. **The signed-in operator can see and change their own account.** Email,
 *      password, logout. Before this screen an operator could not sign out at all
 *      without clearing cookies by hand, and the only password path was a reset
 *      token that arrives by mail — which this build cannot send.
 *
 * Every request here goes over a socket to a real `buildApp` with a real session row;
 * nothing is stubbed.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { totpCode } from '../app/admin/auth.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import {
  ADMIN_HOST,
  ADMIN_ORIGIN,
  PASSWORD,
  TOTP_SECRET,
  login,
  openSession,
  seedUser,
  type Sessioned,
} from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

const NEW_PASSWORD = 'a-perfectly-fine-new-password';

async function get(path: string, opts: { cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  return call({ port, path, host: ADMIN_HOST, headers });
}

/** A no-JS form post: urlencoded, Origin set, session cookie, CSRF in the body. */
async function postForm(path: string, fields: Record<string, string>, opts: { cookie?: string; csrf?: string } = {}): Promise<Res> {
  const body = new URLSearchParams({ ...fields, csrf: opts.csrf ?? session.csrfToken }).toString();
  return call({
    port,
    path,
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      origin: ADMIN_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: opts.cookie ?? session.cookie,
    },
    body,
  });
}

function locationOf(res: Res): string {
  return String(header(res, 'location') ?? '');
}

/** Re-logs in and swaps the session under test (a password change revokes the old one). */
async function reauth(password: string): Promise<void> {
  // S8a-7 moved the address; sign in with the one the row holds now.
  session = await openSession({ port, key: 'acme', email: 'ops@acme.test', password });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme pricing' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app
    .listen({ port: 0, host: '127.0.0.1' })
    .then(() => (handle.app.server.address() as { port: number }).port);
  session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

// --- 1. the front door ------------------------------------------------------

test('S8a-1. /admin with no session is a redirect to the login page, not a 404', async () => {
  const res = await get('/admin');
  assert.equal(res.status, 302, res.body);
  assert.equal(locationOf(res), '/admin/login');
  // The old behaviour, and the one this replaces: "no tenant here" for a path that
  // is exactly where an operator is told to go.
  assert.notEqual(res.status, 404);
  // Nothing may be cached: the answer depends on a cookie.
  assert.equal(String(header(res, 'cache-control')), 'no-store');
});

test('S8a-2. /admin with a session is the page list', async () => {
  const res = await get('/admin', { cookie: session.cookie });
  assert.equal(res.status, 200, res.body);
  assert.match(String(header(res, 'content-type')), /text\/html/);
  assert.match(res.body, /<h1>Your pages<\/h1>/);
});

test('S8a-3. a session for this Host\'s tenant still reaches the tenant home', async () => {
  const res = await get('/admin/t/acme/', { cookie: session.cookie });
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<h1>Your pages<\/h1>/);
});

// --- 2. the account screen --------------------------------------------------

test('S8a-4. the app bar links to the account screen', async () => {
  const res = await get('/admin', { cookie: session.cookie });
  assert.match(res.body, /href="\/admin\/t\/acme\/account"/);
});

test('S8a-5. the account screen shows who you are and how to change it', async () => {
  const res = await get('/admin/t/acme/account', { cookie: session.cookie });
  assert.equal(res.status, 200, res.body);

  // Who you are.
  assert.match(res.body, /owner@acme\.test/);
  assert.match(res.body, /Owner/);

  // Email change: a real form, a real target, a real field.
  assert.match(res.body, /<form method="post" action="\/admin\/t\/acme\/account\/email"/);
  assert.match(res.body, /name="email"[^>]*value="owner@acme\.test"/);

  // Password change: current + new, both password inputs, both labelled.
  assert.match(res.body, /action="\/admin\/t\/acme\/account\/password"/);
  assert.match(res.body, /name="current_password"/);
  assert.match(res.body, /name="new_password"/);
  assert.match(res.body, /<label for="current_password">/);

  // Logout is a POST (it changes state), with the CSRF token bound to this session.
  assert.match(res.body, /action="\/admin\/t\/acme\/logout"/);
  assert.match(res.body, new RegExp(`name="csrf" value="${session.csrfToken}"`));
});

test('S8a-6. the account forms refuse a request with no CSRF token', async () => {
  const res = await call({
    port,
    path: '/admin/t/acme/account/password',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    body: new URLSearchParams({ current_password: PASSWORD, new_password: NEW_PASSWORD }).toString(),
  });
  assert.equal(res.status, 403, res.body);
});

// --- 3. email ---------------------------------------------------------------

test('S8a-7. changing the email changes the identity the next login resolves', async () => {
  const res = await postForm('/admin/t/acme/account/email', { email: 'ops@acme.test', current_password: PASSWORD });
  assert.equal(res.status, 303, res.body);

  const shown = await get('/admin/t/acme/account', { cookie: session.cookie });
  assert.match(shown.body, /ops@acme\.test/);

  // And the row really moved: the old address no longer authenticates, the new one does.
  const old = await login({ port, key: 'acme', email: 'owner@acme.test', totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(old.status, 401, old.body);
  const fresh = await login({ port, key: 'acme', email: 'ops@acme.test', totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(fresh.status, 200, fresh.body);
});

test('S8a-8. an email that is not an email is refused by name', async () => {
  const res = await postForm('/admin/t/acme/account/email', { email: 'not-an-email', current_password: PASSWORD });
  assert.equal(res.status, 303, res.body);
  assert.match(locationOf(res), /e=email/);
  const shown = await get('/admin/t/acme/account', { cookie: session.cookie });
  assert.match(shown.body, /ops@acme\.test/, 'the address must not have changed');
});

/**
 * S8a-7b (E-59). **The sign-in address is not movable by a session alone.**
 *
 * The email is the login identity: a borrowed cookie that can rewrite it can move the account to
 * an address the borrower reads, then take it over through the reset flow. The password change on
 * the same screen re-verifies the current password; this one did not, so the sweep's "Save email"
 * button changed the address with no proof at all. Both refusals are named, and neither writes.
 */
test('S8a-7b. changing the email needs the current password, and a wrong one changes nothing', async () => {
  const absent = await postForm('/admin/t/acme/account/email', { email: 'stolen@acme.test' });
  assert.equal(absent.status, 303, absent.body);
  assert.match(locationOf(absent), /e=current/, 'no password is a refusal, not a pass');
  assert.match((await get('/admin/t/acme/account', { cookie: session.cookie })).body, /ops@acme\.test/);

  const wrong = await postForm('/admin/t/acme/account/email', { email: 'stolen@acme.test', current_password: 'not-the-password' });
  assert.equal(wrong.status, 303, wrong.body);
  assert.match(locationOf(wrong), /e=current/);
  const shown = await get('/admin/t/acme/account', { cookie: session.cookie });
  assert.match(shown.body, /ops@acme\.test/, 'the address is untouched after a wrong password');
  assert.doesNotMatch(shown.body, /stolen@acme\.test/);
});

// --- 4. password ------------------------------------------------------------

test('S8a-9. a wrong current password changes nothing and says so', async () => {
  const res = await postForm('/admin/t/acme/account/password', { current_password: 'not-the-password', new_password: NEW_PASSWORD });
  assert.equal(res.status, 303, res.body);
  assert.match(locationOf(res), /e=current/);

  // The old password still works — the refusal did not half-apply.
  const still = await login({ port, key: 'acme', email: 'ops@acme.test', totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(still.status, 200, still.body);
});

test('S8a-10. a password shorter than the minimum is refused before any hash is made', async () => {
  const res = await postForm('/admin/t/acme/account/password', { current_password: PASSWORD, new_password: 'short' });
  assert.equal(res.status, 303, res.body);
  assert.match(locationOf(res), /e=short/);
});

test('S8a-11. the right current password changes it, and the old one stops working', async () => {
  const res = await postForm('/admin/t/acme/account/password', { current_password: PASSWORD, new_password: NEW_PASSWORD });
  assert.equal(res.status, 303, res.body);
  assert.match(locationOf(res), /changed=1/);

  const stale = await login({ port, key: 'acme', email: 'ops@acme.test', password: PASSWORD, totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(stale.status, 401, stale.body);

  await reauth(NEW_PASSWORD);
  const live = await get('/admin/t/acme/account', { cookie: session.cookie });
  assert.equal(live.status, 200, live.body);
});

// --- 5. logout --------------------------------------------------------------

test('S8a-12. logout ends the session on the server and clears the cookie', async () => {
  const res = await postForm('/admin/t/acme/logout', {});
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(res.json, { ok: true });

  const cleared = String(header(res, 'set-cookie'));
  assert.match(cleared, /Max-Age=0|Expires=Thu, 01 Jan 1970/);

  // The server-side row is gone: the same cookie is now worth nothing.
  const after = await get('/admin', { cookie: session.cookie });
  assert.equal(after.status, 302, after.body);
  assert.equal(locationOf(after), '/admin/login');
});
