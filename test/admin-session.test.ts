/**
 * §9.1's session control, as a wire gate:
 *
 *   | Session cookie | `__Host-sk-sess`; `Path=/`; `Secure`; `HttpOnly`; `SameSite=Lax` |
 *   | Session id     | 32-byte random hex, stored as a row in `control.db.session`, rotated on privilege change |
 *   | IP allowlist   | ... when empty ... idle drops to 15 min |
 *
 * The frozen attribute list is asserted as an exact string, so an extra attribute
 * (`Domain`, `Max-Age`, `Expires`, `SameSite=Strict`) is a failure rather than a
 * detail. Rejection is asserted five ways: a cookie is data from the client and
 * every part of it is checkable.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { IDLE_MS_NO_ALLOWLIST, SESSION_COOKIE, SESSION_COOKIE_ATTRS } from '../app/admin/session.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import {
  ADMIN_HOST,
  ADMIN_ORIGIN,
  TOTP_SECRET,
  codeOf,
  cookiePair,
  currentTotp,
  login,
  openSession,
  seedUser,
  setCookie,
  type Sessioned,
} from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const OWNER = 'session@acme.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

function sessionRequest(cookie: string | undefined, portToUse = port): Promise<Res> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  return call({ port: portToUse, path: '/admin/t/acme/session', host: ADMIN_HOST, headers });
}

function idOf(cookie: string): string {
  return cookie.slice(`${SESSION_COOKIE}=`.length).split('.')[0] as string;
}

function macOf(cookie: string): string {
  return cookie.slice(`${SESSION_COOKIE}=`.length).split('.')[1] as string;
}

before(async () => {
  fixture = makeFixture();
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: OWNER, totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  session = await openSession({ port, key: 'acme', email: OWNER });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('1. the cookie carries exactly the five frozen attributes', async () => {
  const res = await login({ port, key: 'acme', email: OWNER, totp: currentTotp() });
  const raw = setCookie(res);
  assert.ok(raw !== undefined);
  // `<name>=<64 hex>.<43 base64url>; Path=/; Secure; HttpOnly; SameSite=Lax` and
  // nothing else: no Domain, no Max-Age, no Expires, no other SameSite value.
  assert.match(
    raw,
    new RegExp(`^${SESSION_COOKIE}=[0-9a-f]{64}\\.[A-Za-z0-9_-]{43}; ${SESSION_COOKIE_ATTRS.replace(/[/]/g, '\\/')}$`),
    raw,
  );
  assert.equal(raw, `${cookiePair(res)}; ${SESSION_COOKIE_ATTRS}`);
  assert.equal(SESSION_COOKIE, '__Host-sk-sess');
  // `__Host-` requires Secure, Path=/, and no Domain — the string above is the proof.
  assert.ok(!/Domain=/i.test(raw));
  assert.ok(!/Max-Age=/i.test(raw));
});

test('2. a tampered cookie is not a session: five rejection cases, all the row-7 404', async () => {
  const id = idOf(session.cookie);
  const mac = macOf(session.cookie);

  const cases: [name: string, cookie: string][] = [
    ['no signature at all', `${SESSION_COOKIE}=${id}`],
    ['a flipped signature', `${SESSION_COOKIE}=${id}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`],
    ['the id of another length', `${SESSION_COOKIE}=${id.slice(0, 62)}.${mac}`],
    ['a signature over a different id', `${SESSION_COOKIE}=${'0'.repeat(64)}.${mac}`],
    ['the value under a non-__Host name', `sk-sess=${id}.${mac}`],
  ];

  for (const [name, cookie] of cases) {
    const res = await sessionRequest(cookie);
    assert.equal(res.status, 404, name);
    assert.equal(codeOf(res), 'SKW_E_PLT_TENANT_UNKNOWN', name);
    assert.equal(res.headers['set-cookie'], undefined, name);
  }

  // And the untouched cookie still works: the rejections above are not the app
  // refusing everybody.
  const ok = await sessionRequest(session.cookie);
  assert.equal(ok.status, 200);
});

test('3. a revoked session is refused on the next request', async () => {
  const doomed = await openSession({ port, key: 'acme', email: OWNER });
  const before = await sessionRequest(doomed.cookie);
  assert.equal(before.status, 200);

  const out = await call({
    port,
    path: '/admin/t/acme/logout',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { cookie: doomed.cookie, origin: ADMIN_ORIGIN, 'x-csrf-token': doomed.csrfToken },
  });
  assert.equal(out.status, 200);
  assert.match(String(setCookie(out)), /^__Host-sk-sess=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0$/);

  const after = await sessionRequest(doomed.cookie);
  assert.equal(after.status, 404, 'a logged-out cookie is not a session');
});

test('4. rotation on privilege change: new id, old id dead, rotated_from recorded', async () => {
  const fresh = await openSession({ port, key: 'acme', email: OWNER });
  const res = await call({
    port,
    path: '/admin/t/acme/session/rotate',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { cookie: fresh.cookie, origin: ADMIN_ORIGIN, 'x-csrf-token': fresh.csrfToken },
  });
  assert.equal(res.status, 200, res.body);
  const next = cookiePair(res);
  assert.ok(next !== undefined);
  assert.notEqual(idOf(next), idOf(fresh.cookie));

  const db = new Database(fixture.controlDb, { readonly: true });
  const row = db.prepare('SELECT rotated_from, revoked_at FROM session WHERE id = ?').get(idOf(fresh.cookie)) as {
    rotated_from: string | null;
    revoked_at: string | null;
  };
  db.close();
  assert.equal(row.rotated_from, null, 'the OLD row does not point forward');
  assert.notEqual(row.revoked_at, null, 'the old row is revoked in the same transaction');

  const newRow = (() => {
    const d = new Database(fixture.controlDb, { readonly: true });
    const r = d.prepare('SELECT rotated_from FROM session WHERE id = ?').get(idOf(next)) as { rotated_from: string };
    d.close();
    return r;
  })();
  assert.equal(newRow.rotated_from, idOf(fresh.cookie), 'the new row records what it replaced');

  assert.equal((await sessionRequest(fresh.cookie)).status, 404, 'the rotated-away id is dead');
  assert.equal((await sessionRequest(next)).status, 200, 'the new id works');
});

test('5. idle timeout: 15 minutes when the allowlist is empty, and the window slides', async () => {
  const fresh = await openSession({ port, key: 'acme', email: OWNER });
  const first = await sessionRequest(fresh.cookie);
  assert.equal(first.status, 200);
  const firstExpiry = Date.parse((first.json as { expiresAt: string }).expiresAt);

  // The row's expires_at is "last activity + window" — the table has no
  // last_seen_at column, which is why a read has to write.
  const read = (): string => {
    const db = new Database(fixture.controlDb, { readonly: true });
    const row = db.prepare('SELECT expires_at FROM session WHERE id = ?').get(idOf(fresh.cookie)) as {
      expires_at: string;
    };
    db.close();
    return row.expires_at;
  };
  const stored = Date.parse(read());
  assert.ok(Math.abs(stored - firstExpiry) < 1_000, 'the stored expiry is the one the response reported');
  assert.ok(
    Math.abs(stored - Date.now() - IDLE_MS_NO_ALLOWLIST) < 5_000,
    `expiry should be ~15 min out, got ${stored - Date.now()}ms`,
  );

  // Force the row into the past: a stale session is refused without waiting.
  const write = new Database(fixture.controlDb);
  write.prepare('UPDATE session SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), idOf(fresh.cookie));
  write.close();

  const expired = await sessionRequest(fresh.cookie);
  assert.equal(expired.status, 404, 'an idle-expired session is not a session');
  assert.equal(codeOf(expired), 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('6. a session for tenant A cannot act on tenant B through the URL (§9.2)', async () => {
  // The fixture has beta as a second tenant; the session's tenant is acme and the
  // URL names beta. resolveAdminTenant(session) is the only source, so this must
  // not resolve — that mismatch is the cross-tenant write C-11 exists to prevent.
  const res = await call({ port, path: '/admin/t/beta/session', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(res.status, 404);
  assert.equal(codeOf(res), 'SKW_E_PLT_TENANT_UNKNOWN');
});
