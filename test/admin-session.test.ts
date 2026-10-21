/**
 * §9.1's session control, as a wire gate — **with D37's cookie replacing §9.1's**.
 *
 *   | Session cookie | `__Secure-sk-sess-<tenantKey>`; `Path=/admin`; `Secure`; `HttpOnly`; `SameSite=Strict` |
 *   | Session id     | 32-byte random hex, stored as a row in `control.db.session`, rotated on privilege change |
 *   | IP allowlist   | ... when empty ... idle drops to 15 min |
 *
 * D37 supersedes the old row (`__Host-sk-sess`; `Path=/`; `SameSite=Lax`). Three of
 * those four old attributes are gone for reasons the decision names: `__Host-` cannot
 * carry `Path=/admin` (§7.4.3's erratum is the same rule), `Path=/` was only meaningful
 * when the admin surface was its own host, and `Lax` was survivable only because the
 * admin was cross-origin from tenant HTML. The attribute list is still asserted as an
 * exact string, so an extra attribute (`Domain`, `Expires`, a second `Path`) is a
 * failure rather than a detail. Rejection is still asserted from the client side: a
 * cookie is data from the client and every part of it is checkable.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import {
  ADMIN_COOKIE_PATH,
  IDLE_MS_NO_ALLOWLIST,
  SESSION_ABSOLUTE_MS,
  cookieAttrs,
  sessionCookieName,
} from '../app/admin/session.ts';
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

/** The cookie this file's tenant (`acme`) is issued, under D37's naming. */
const COOKIE = sessionCookieName('acme');
const ATTRS = cookieAttrs(ADMIN_COOKIE_PATH);

function idOf(cookie: string): string {
  return cookie.slice(`${COOKIE}=`.length).split('.')[0] as string;
}

function macOf(cookie: string): string {
  return cookie.slice(`${COOKIE}=`.length).split('.')[1] as string;
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

test('1. the cookie carries exactly D37\'s attribute list, in D37\'s order', async () => {
  const res = await login({ port, key: 'acme', email: OWNER, totp: currentTotp() });
  const raw = setCookie(res);
  assert.ok(raw !== undefined);
  // `<per-tenant name>=<64 hex>.<43 base64url>; HttpOnly; Secure; SameSite=Strict; Path=/admin`
  // and nothing else: no Domain, no Max-Age, no Expires, no other SameSite value.
  assert.match(raw, new RegExp(`^${COOKIE}=[0-9a-f]{64}\\.[A-Za-z0-9_-]{43}; ${ATTRS.replace(/[/]/g, '\\/')}$`), raw);
  assert.equal(raw, `${cookiePair(res)}; ${ATTRS}`);
  assert.equal(COOKIE, '__Secure-sk-sess-acme');
  // D37's order, asserted literally: HttpOnly, Secure, SameSite=Strict, Path.
  assert.equal(ATTRS, 'HttpOnly; Secure; SameSite=Strict; Path=/admin');
  // A `Domain` attribute would let one tenant host read another's cookie; `__Secure-`
  // forbids it, and so does this.
  assert.ok(!/Domain=/i.test(raw));
  assert.ok(!/Max-Age=/i.test(raw));
  // `__Host-` is not available at a path other than `/` (§7.4.3's erratum, same rule).
  assert.ok(!raw.startsWith('__Host-'));
});

test('2. a tampered cookie is not a session: five rejection cases, all the row-7 404', async () => {
  const id = idOf(session.cookie);
  const mac = macOf(session.cookie);

  const cases: [name: string, cookie: string][] = [
    ['no signature at all', `${COOKIE}=${id}`],
    ['a flipped signature', `${COOKIE}=${id}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`],
    ['the id of another length', `${COOKIE}=${id.slice(0, 62)}.${mac}`],
    ['a signature over a different id', `${COOKIE}=${'0'.repeat(64)}.${mac}`],
    // D37: the value under another tenant's name, and under the fleet name. A session
    // id is only a session in its own namespace.
    ["another tenant's name", `${sessionCookieName('beta')}=${id}.${mac}`],
    ['the fleet name', `__Secure-sk-fleet=${id}.${mac}`],
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
  assert.match(
    String(setCookie(out)),
    new RegExp(`^${COOKIE}=; ${ATTRS.replace(/[/]/g, '\\/')}; Max-Age=0$`),
    'the clearing cookie names the same name and the same path, or the browser keeps the original',
  );

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

// --- E-18: a 12-hour cap over the sliding idle window -----------------------

/** The stored row, so an assertion can be about the row and not the response. */
function rowOf(id: string): { created_at: string; expires_at: string; revoked_at: string | null } {
  const db = new Database(fixture.controlDb, { readonly: true });
  const row = db.prepare('SELECT created_at, expires_at, revoked_at FROM session WHERE id = ?').get(id) as {
    created_at: string;
    expires_at: string;
    revoked_at: string | null;
  };
  db.close();
  return row;
}

function updateRow(id: string, fields: { created_at?: string; expires_at?: string }): void {
  const db = new Database(fixture.controlDb);
  if (fields.created_at !== undefined) db.prepare('UPDATE session SET created_at = ? WHERE id = ?').run(fields.created_at, id);
  if (fields.expires_at !== undefined) db.prepare('UPDATE session SET expires_at = ? WHERE id = ?').run(fields.expires_at, id);
  db.close();
}

test('7. E-18(a): a session touched every 5 minutes is refused at created_at + 12 h, with 404 and no Set-Cookie', async () => {
  const fresh = await openSession({ port, key: 'acme', email: OWNER });
  const id = idOf(fresh.cookie);
  const created = Date.parse(rowOf(id).created_at);

  // Continuous use: one touch every five minutes, straight through the cap. Every
  // touch before the cap is a live session; the one at the cap is not. The idle
  // deadline starts at the cap, which is where continuous use would have put it.
  updateRow(id, { expires_at: new Date(created + SESSION_ABSOLUTE_MS).toISOString() });
  const step = 5 * 60_000;
  for (let t = created + step; t < created + SESSION_ABSOLUTE_MS; t += step) {
    assert.notEqual(handle.admin.sessions.readAndTouch(id, t, IDLE_MS_NO_ALLOWLIST), null, `live at +${(t - created) / 60_000} min`);
  }
  assert.equal(
    handle.admin.sessions.readAndTouch(id, created + SESSION_ABSOLUTE_MS, IDLE_MS_NO_ALLOWLIST),
    null,
    'the lineage dies at exactly 12 h however continuously it is used',
  );

  // The same thing on the wire, with a *recent* idle deadline: a polling tab is
  // always "active", so activity must not buy an extension.
  updateRow(id, {
    created_at: new Date(Date.now() - SESSION_ABSOLUTE_MS - 1_000).toISOString(),
    expires_at: new Date(Date.now() + IDLE_MS_NO_ALLOWLIST).toISOString(),
  });
  const before = rowOf(id).expires_at;
  const res = await sessionRequest(fresh.cookie);
  assert.equal(res.status, 404);
  assert.equal(codeOf(res), 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(res.headers['set-cookie'], undefined, 'a refused request must not reissue the cookie');
  assert.equal(rowOf(id).expires_at, before, 'a refused request must not slide the row');
});

test('8. E-18(b): the slide clamps at created_at + SESSION_ABSOLUTE_MS, asserted on the stored value', async () => {
  const fresh = await openSession({ port, key: 'acme', email: OWNER });
  const id = idOf(fresh.cookie);
  const created = Date.parse(rowOf(id).created_at);

  // Ten minutes before the cap a 15-minute idle window would cross it.
  const near = created + SESSION_ABSOLUTE_MS - 10 * 60_000;
  updateRow(id, { expires_at: new Date(near + 1_000).toISOString() });
  const touched = handle.admin.sessions.readAndTouch(id, near, IDLE_MS_NO_ALLOWLIST);
  assert.notEqual(touched, null);
  assert.equal(
    Date.parse(rowOf(id).expires_at),
    created + SESSION_ABSOLUTE_MS,
    'expires_at is the clamp, not now + idle',
  );

  // And it never exceeds the cap on a later touch either.
  handle.admin.sessions.readAndTouch(id, near + 9 * 60_000, IDLE_MS_NO_ALLOWLIST);
  assert.equal(Date.parse(rowOf(id).expires_at), created + SESSION_ABSOLUTE_MS);
  assert.ok(SESSION_ABSOLUTE_MS === 12 * 60 * 60_000);
});

test('9. E-18(c): rotation at 11 h 59 m inherits created_at, so the child dies one minute later', async () => {
  const fresh = await openSession({ port, key: 'acme', email: OWNER });
  const id = idOf(fresh.cookie);
  const created = Date.now() - (SESSION_ABSOLUTE_MS - 60_000);
  updateRow(id, { created_at: new Date(created).toISOString() });

  const res = await call({
    port,
    path: '/admin/t/acme/session/rotate',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { cookie: fresh.cookie, origin: ADMIN_ORIGIN, 'x-csrf-token': fresh.csrfToken },
  });
  assert.equal(res.status, 200, res.body);
  const child = cookiePair(res);
  assert.ok(child !== undefined);
  const childRow = rowOf(idOf(child));
  assert.equal(Date.parse(childRow.created_at), created, "the child inherits the parent's created_at");
  assert.equal(
    Date.parse(childRow.expires_at),
    created + SESSION_ABSOLUTE_MS,
    'so its idle deadline is clamped by the same cap',
  );
  // One minute later the child is dead, even though it was minted a second ago.
  const cap = created + SESSION_ABSOLUTE_MS;
  assert.notEqual(handle.admin.sessions.read(idOf(child), cap - 1), null);
  assert.equal(handle.admin.sessions.read(idOf(child), cap + 1), null);
});

test('10. E-18(d): a session dead by idle inside the cap is refused, and the attempt does not slide it', async () => {
  const fresh = await openSession({ port, key: 'acme', email: OWNER });
  const id = idOf(fresh.cookie);
  const expiredAt = new Date(Date.now() - 1_000).toISOString();
  updateRow(id, { created_at: new Date(Date.now() - 60 * 60_000).toISOString(), expires_at: expiredAt });

  const res = await sessionRequest(fresh.cookie);
  assert.equal(res.status, 404, 'dead by idle, inside the cap, is still dead');
  assert.equal(codeOf(res), 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(rowOf(id).expires_at, expiredAt, 'the refused attempt wrote nothing');
});

test('6. a session for tenant A cannot act on tenant B through the URL (§9.2)', async () => {
  // The fixture has beta as a second tenant; the session's tenant is acme and the
  // URL names beta. resolveAdminTenant(session) is the only source, so this must
  // not resolve — that mismatch is the cross-tenant write C-11 exists to prevent.
  const res = await call({ port, path: '/admin/t/beta/session', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(res.status, 404);
  assert.equal(codeOf(res), 'SKW_E_PLT_TENANT_UNKNOWN');
});
