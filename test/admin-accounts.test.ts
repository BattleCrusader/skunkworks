/**
 * S9 — the operator's accounts and roles screen.
 *
 * Before this file the admin had no reference to `cms_account` at all: an operator could read
 * a tenant's pages, plugins and media, and could not see — let alone stop — the people the
 * tenant had signed up. Every promise this screen makes is checked here against real rows in a
 * real `site.db`, over a socket to a real `buildApp`:
 *
 *   1. the list is the accounts, their roles and their two proofs;
 *   2. `?q=` is a substring and `?status=` is the column's own vocabulary, both as bound
 *      parameters — a `%` in the search box is a percent sign, not every row;
 *   3. suspending or closing revokes the account's sessions **in the same write**;
 *   4. activating an account that has not proved its address, or has not confirmed its
 *      authenticator, is refused with the proof named — not with `SQLITE_CONSTRAINT`;
 *   5. roles round-trip, the last one cannot be revoked, and every write is audited;
 *   6. origin, then CSRF, then the write — in that order, on every POST;
 *   7. `password_hash` and `totp_secret` never reach a byte of the HTML.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET as OPERATOR_TOTP, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

/**
 * The two columns this screen must never print, with a marker a test can search for. The
 * values are shaped like the real ones (`cms_account`'s CHECKs fix the lengths, not the text),
 * so a row here is a row the schema accepts.
 */
const PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$LEAKCANARYPASSWORDHASH000000000000000';
const ACCOUNT_TOTP = 'JBSWY3DPEHPK3PXPLEAKCANARYTOTPSECRET';

const SAM = 'sam@acme.test';
const NEWBIE = 'newbie@acme.test';
const HALFWAY = 'halfway@acme.test';
const ROLES = 'roles@acme.test';
const LASTROLE = 'lastrole@acme.test';
const CLOSED = 'gone@acme.test';

interface SeedAccount {
  email: string;
  status?: 'pending' | 'active' | 'suspended' | 'closed';
  verified?: boolean;
  totpConfirmed?: boolean;
  roles?: readonly ('applicant' | 'advertiser')[];
  failedLogins?: number;
  lastLoginAt?: string | null;
  profile?: boolean;
}

/** A real account row: the schema's two CHECKs make an inconsistent one impossible to insert. */
function seedAccount(seed: SeedAccount): number {
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.pragma('foreign_keys = ON');
    const info = db
      .prepare(
        `INSERT INTO cms_account (email, status, password_hash, totp_secret, totp_confirmed_at, email_verified, failed_logins, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seed.email,
        seed.status ?? 'active',
        PASSWORD_HASH,
        ACCOUNT_TOTP,
        (seed.totpConfirmed ?? true) ? '2026-10-01T00:00:00.000Z' : null,
        (seed.verified ?? true) ? 1 : 0,
        seed.failedLogins ?? 0,
        seed.lastLoginAt === undefined ? '2026-10-20T09:00:00.000Z' : seed.lastLoginAt,
      );
    const id = Number(info.lastInsertRowid);
    const grant = db.prepare('INSERT INTO cms_account_role (account_id, role) VALUES (?, ?)');
    for (const role of seed.roles ?? ['applicant']) grant.run(id, role);
    if (seed.profile === true) {
      db.prepare(
        `INSERT INTO cms_profile (account_id, display_name, headline, day_rate_cents, availability_days_per_week, remote_ok, visibility)
         VALUES (?, 'Sam Rivers', 'Fractional CTO', 120000, 3, 1, 'discoverable')`,
      ).run(id);
    }
    return id;
  } finally {
    db.close();
  }
}

/** A portal session row. `id` is the token's hash, so 64 hex characters, as the column demands. */
function seedSession(accountId: number, opts: { revoked?: boolean; expiresAt?: string } = {}): string {
  const id = randomBytes(32).toString('hex');
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare(
      `INSERT INTO cms_account_session (id, account_id, csrf_secret, ip_hash, ua_hash, created_at, last_seen_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, '2026-10-20T08:00:00.000Z', '2026-10-20T09:00:00.000Z', ?, ?)`,
    ).run(
      id,
      accountId,
      randomBytes(24).toString('hex'),
      'a'.repeat(64),
      'b'.repeat(64),
      opts.expiresAt ?? '2030-01-01T00:00:00.000Z',
      opts.revoked === true ? '2026-10-20T09:30:00.000Z' : null,
    );
    return id;
  } finally {
    db.close();
  }
}

function seedMail(to: string, template: string, status: string, lastError: string | null, at: string): void {
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare(
      `INSERT INTO cms_mail (to_email, template, subject, vars_json, status, last_error, idempotency_key, created_at)
       VALUES (?, ?, ?, '{}', ?, ?, ?, ?)`,
    ).run(to, template, `subject ${template}`, status, lastError, `${template}:${to}:${at}`, at);
  } finally {
    db.close();
  }
}

function rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
  const db = new Database(fixture.sitePath('acme'));
  try {
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function get(path: string): Promise<Res> {
  return call({ port, path, host: ADMIN_HOST, headers: { cookie: session.cookie } });
}

interface PostOptions {
  cookie?: string;
  csrf?: string | null;
  origin?: string | null;
}

/** A no-JS form post: urlencoded, Origin set, session cookie, CSRF in the body. */
function post(path: string, fields: Record<string, string>, opts: PostOptions = {}): Promise<Res> {
  const body = new URLSearchParams(fields);
  if (opts.csrf !== null) body.set('csrf', opts.csrf ?? session.csrfToken);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    cookie: opts.cookie ?? session.cookie,
  };
  if (opts.origin !== null) headers.origin = opts.origin ?? ADMIN_ORIGIN;
  return call({ port, path, method: 'POST', host: ADMIN_HOST, headers, body: body.toString() });
}

function locationOf(res: Res): string {
  return String(header(res, 'location') ?? '');
}

function codeOf(res: Res): string | undefined {
  return (res.json as { error?: { code?: string } } | undefined)?.error?.code;
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [ADMIN_HOST], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: OPERATOR_TOTP });

  // A tenant with people in it: one healthy account with everything filled in, one who never
  // finished signing up, one who proved the address and not the authenticator, and one stop.
  seedAccount({
    email: SAM,
    roles: ['applicant', 'advertiser'],
    failedLogins: 2,
    profile: true,
  });
  seedAccount({ email: NEWBIE, status: 'pending', verified: false, totpConfirmed: false, roles: ['applicant'], lastLoginAt: null });
  seedAccount({ email: HALFWAY, status: 'pending', verified: true, totpConfirmed: false, roles: ['applicant'], lastLoginAt: null });
  seedAccount({ email: ROLES, roles: ['applicant'], profile: false });
  seedAccount({ email: LASTROLE, roles: ['advertiser'], profile: false });
  seedAccount({ email: CLOSED, status: 'closed', roles: ['applicant'], lastLoginAt: null });

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

// --- 1. the list ------------------------------------------------------------

test('S9-1. the admin home links to the accounts screen, which lists every account and its roles', async () => {
  const home = await get('/admin/t/acme/');
  assert.equal(home.status, 200, home.body);
  assert.match(home.body, /href="\/admin\/t\/acme\/accounts"/, 'the home screen must reach the new screen');

  const res = await get('/admin/t/acme/accounts');
  assert.equal(res.status, 200, res.body);
  assert.match(String(header(res, 'content-type')), /text\/html/);
  assert.match(res.body, /<h1>Accounts — acme<\/h1>/);

  // The address, the lifecycle, both proofs as words, the roles and the counters.
  assert.match(res.body, new RegExp(SAM.replace(/\./g, '\\.')));
  // Roles are listed in the column's own order, so the screen and the row agree.
  assert.match(res.body, /sam@acme\.test<\/a><\/td><td>active<\/td><td>yes<\/td><td>yes<\/td><td>advertiser, applicant<\/td><td>2<\/td>/);
  assert.match(res.body, /newbie@acme\.test<\/a><\/td><td>pending<\/td><td>no<\/td><td>no<\/td>/);
  // A row links to its own detail screen.
  assert.match(res.body, /href="\/admin\/t\/acme\/accounts\/\d+"/);
});

test('S9-2. ?q= is a substring of the address, and a % in the box is a percent sign', async () => {
  const filtered = await get('/admin/t/acme/accounts?q=sam');
  assert.equal(filtered.status, 200, filtered.body);
  assert.match(filtered.body, /sam@acme\.test/);
  assert.doesNotMatch(filtered.body, /newbie@acme\.test/, 'a substring search may not return the whole table');

  // A needle that is a wildcard is still a needle: `%` must not match every address.
  const wildcard = await get('/admin/t/acme/accounts?q=%25');
  assert.equal(wildcard.status, 200, wildcard.body);
  assert.match(wildcard.body, /No account matches this filter/);
  assert.doesNotMatch(wildcard.body, /sam@acme\.test/);

  // The same for `_`, which is the other wildcard.
  const underscore = await get('/admin/t/acme/accounts?q=_');
  assert.match(underscore.body, /No account matches this filter/);
});

test('S9-3. ?status= selects one lifecycle, and a value outside the column is refused by name', async () => {
  const closed = await get('/admin/t/acme/accounts?status=closed');
  assert.equal(closed.status, 200, closed.body);
  assert.match(closed.body, /gone@acme\.test/);
  assert.doesNotMatch(closed.body, /sam@acme\.test/);

  const bad = await get('/admin/t/acme/accounts?status=paused');
  assert.equal(bad.status, 400, bad.body);
  assert.equal(codeOf(bad), 'SKW_E_PLT_REQUEST_INVALID');
  assert.match(bad.body, /status must be one of pending, active, suspended, closed/);
});

test('S9-4. paging is bounded and always says how many rows there are', async () => {
  const res = await get('/admin/t/acme/accounts?limit=2');
  assert.equal(res.status, 200, res.body);
  assert.equal((res.body.match(/data-account="/g) ?? []).length, 2, 'limit=2 is two rows');
  assert.match(res.body, /1–2 of 6/);
  assert.match(res.body, /rel="next"/);

  const second = await get('/admin/t/acme/accounts?limit=2&offset=2');
  assert.equal(second.status, 200, second.body);
  assert.match(second.body, /rel="prev"/);
  assert.equal((second.body.match(/data-account="/g) ?? []).length, 2);

  // A limit past the ceiling is clamped, not honoured: this tenant's six accounts arrive on
  // one page, and no page is ever asked to be 100 000 rows.
  const huge = await get('/admin/t/acme/accounts?limit=100000');
  assert.equal(huge.status, 200, huge.body);
  assert.equal((huge.body.match(/data-account="/g) ?? []).length, 6);

  // A limit that is not a number is a refusal, not a silent default.
  const nonsense = await get('/admin/t/acme/accounts?limit=twenty');
  assert.equal(nonsense.status, 400, nonsense.body);
  assert.equal(codeOf(nonsense), 'SKW_E_PLT_REQUEST_INVALID');
});

// --- 2. the detail ----------------------------------------------------------

test('S9-5. the detail screen shows the profile, the outbox and the live-session count — and no secret', async () => {
  const sam = rows('SELECT id FROM cms_account WHERE email = ?', SAM)[0] as { id: number };
  seedSession(sam.id);
  seedSession(sam.id, { revoked: true });
  seedMail(SAM, 'verify_email', 'sent', null, '2026-10-20T08:00:00.000Z');
  seedMail(SAM, 'reset_password', 'failed', '550 mailbox unavailable', '2026-10-21T08:00:00.000Z');

  const res = await get(`/admin/t/acme/accounts/${sam.id}`);
  assert.equal(res.status, 200, res.body);

  // The account fields an operator supports from.
  assert.match(res.body, new RegExp(`<h1>${SAM.replace(/\./g, '\\.')}</h1>`));
  assert.match(res.body, /Email verified<\/dt><dd>yes/);
  assert.match(res.body, /Authenticator confirmed<\/dt><dd>yes/);
  assert.match(res.body, /Failed sign-ins<\/dt><dd>2/);

  // The profile, through the policy's projection.
  assert.match(res.body, /Sam Rivers/);
  assert.match(res.body, /Fractional CTO/);
  assert.match(res.body, /1200\.00 AUD/);
  assert.match(res.body, /3 days a week/);
  assert.match(res.body, /Visibility<\/dt><dd>discoverable/);

  // The outbox: both rows, the failure's own sentence included.
  assert.match(res.body, /verify_email<\/td><td>sent/);
  assert.match(res.body, /reset_password<\/td><td>failed/);
  assert.match(res.body, /550 mailbox unavailable/);

  // Sessions: two rows, one of them dead.
  assert.match(res.body, /2 session rows, 1 live/);

  // The two columns this screen may not print, by name and by value.
  assert.doesNotMatch(res.body, /password_hash/);
  assert.doesNotMatch(res.body, /totp_secret/);
  assert.ok(!res.body.includes(PASSWORD_HASH), 'the password hash reached the HTML');
  assert.ok(!res.body.includes(ACCOUNT_TOTP), 'the TOTP secret reached the HTML');
  assert.ok(!res.body.includes('LEAKCANARY'), 'a secret marker reached the HTML');
});

test('S9-6. an unknown id is the 404 every other admin path answers', async () => {
  const res = await get('/admin/t/acme/accounts/999999');
  assert.equal(res.status, 404, res.body);
  assert.equal(codeOf(res), 'SKW_E_PLT_TENANT_UNKNOWN');

  const write = await post('/admin/t/acme/accounts/999999/status', { status: 'suspended' });
  assert.equal(write.status, 404, write.body);
  assert.equal(codeOf(write), 'SKW_E_PLT_TENANT_UNKNOWN');
});

// --- 3. status --------------------------------------------------------------

test('S9-7. suspending an account revokes every live session it holds, in the same write', async () => {
  const sam = rows('SELECT id FROM cms_account WHERE email = ?', SAM)[0] as { id: number };
  // The account arrived from S9-5 with one live session and one already revoked.
  const before = rows('SELECT id, revoked_at FROM cms_account_session WHERE account_id = ?', sam.id);
  assert.equal(before.length, 2);
  assert.equal(before.filter((row) => row.revoked_at === null).length, 1, 'one live session to revoke');

  const res = await post(`/admin/t/acme/accounts/${sam.id}/status`, { status: 'suspended' });
  assert.equal(res.status, 303, res.body);
  assert.match(locationOf(res), new RegExp(`^/admin/t/acme/accounts/${sam.id}\\?result=`));

  const account = rows('SELECT status FROM cms_account WHERE id = ?', sam.id)[0] as { status: string };
  assert.equal(account.status, 'suspended');
  const sessions = rows('SELECT id, revoked_at FROM cms_account_session WHERE account_id = ?', sam.id);
  assert.equal(sessions.length, 2, 'revocation marks the row; it does not delete the history');
  assert.deepEqual(
    sessions.map((row) => row.revoked_at === null),
    [false, false],
    'every session a suspended account holds is revoked',
  );

  // The redirect's flash names what happened, and the detail screen renders it.
  const flash = await get(locationOf(res));
  assert.equal(flash.status, 200, flash.body);
  assert.match(flash.body, /sam@acme\.test is suspended; 1 session was revoked\./);
  assert.match(flash.body, /<dd>suspended<\/dd>/);

  // The operator's decision is in the control plane's audit log, with the action name it promised.
  const db = new Database(fixture.controlDb);
  try {
    const entry = db
      .prepare('SELECT action, target_id, after_json FROM audit_log WHERE action = ? ORDER BY id DESC')
      .get('admin.account.status') as { action: string; target_id: string; after_json: string } | undefined;
    assert.ok(entry !== undefined, 'no audit row for admin.account.status');
    assert.equal(entry.target_id, String(sam.id));
    const after = JSON.parse(entry.after_json) as { from: string; to: string; revoked_sessions: number };
    assert.deepEqual(after, { from: 'active', to: 'suspended', revoked_sessions: 1 });
  } finally {
    db.close();
  }
});

test('S9-8. activating an unverified account is refused by name and changes nothing', async () => {
  const newbie = rows('SELECT id FROM cms_account WHERE email = ?', NEWBIE)[0] as { id: number };
  const res = await post(`/admin/t/acme/accounts/${newbie.id}/status`, { status: 'active' });
  assert.equal(res.status, 400, res.body);
  assert.match(res.body, /cannot activate newbie@acme\.test: its email address has not been verified and its authenticator has not been confirmed\./);
  assert.match(res.body, /nothing was changed/);
  assert.match(res.body, /data-account-refusal="1"/);
  // A constraint message names a table; this names the proof.
  assert.doesNotMatch(res.body, /SQLITE_CONSTRAINT|CHECK constraint/);

  assert.equal((rows('SELECT status FROM cms_account WHERE id = ?', newbie.id)[0] as { status: string }).status, 'pending');
});

test('S9-9. a verified address with no confirmed authenticator names the second proof', async () => {
  const halfway = rows('SELECT id FROM cms_account WHERE email = ?', HALFWAY)[0] as { id: number };
  const res = await post(`/admin/t/acme/accounts/${halfway.id}/status`, { status: 'active' });
  assert.equal(res.status, 400, res.body);
  assert.match(res.body, /its authenticator has not been confirmed/);
  assert.doesNotMatch(res.body, /its email address has not been verified/);
  assert.equal((rows('SELECT status FROM cms_account WHERE id = ?', halfway.id)[0] as { status: string }).status, 'pending');
});

test('S9-10. "pending" is not an operator decision', async () => {
  const newbie = rows('SELECT id FROM cms_account WHERE email = ?', NEWBIE)[0] as { id: number };
  const res = await post(`/admin/t/acme/accounts/${newbie.id}/status`, { status: 'pending' });
  assert.equal(res.status, 400, res.body);
  assert.equal(codeOf(res), 'SKW_E_PLT_REQUEST_INVALID');
  assert.match(res.body, /pending is what the sign-up flow decides/);
});

// --- 4. roles ---------------------------------------------------------------

test('S9-11. a grant and a revocation round-trip, and each write is audited', async () => {
  const account = rows('SELECT id FROM cms_account WHERE email = ?', ROLES)[0] as { id: number };

  const granted = await post(`/admin/t/acme/accounts/${account.id}/roles`, { role: 'advertiser', op: 'grant' });
  assert.equal(granted.status, 303, granted.body);
  assert.deepEqual(
    rows('SELECT role FROM cms_account_role WHERE account_id = ? ORDER BY role', account.id).map((row) => row.role),
    ['advertiser', 'applicant'],
  );
  const grantedFlash = await get(locationOf(granted));
  assert.match(grantedFlash.body, /granted advertiser to roles@acme\.test\./);

  // Granting again is not an error and writes nothing.
  const again = await post(`/admin/t/acme/accounts/${account.id}/roles`, { role: 'advertiser', op: 'grant' });
  assert.equal(again.status, 303, again.body);
  assert.match(locationOf(again), /already%20holds%20advertiser/);

  const revoked = await post(`/admin/t/acme/accounts/${account.id}/roles`, { role: 'applicant', op: 'revoke' });
  assert.equal(revoked.status, 303, revoked.body);
  assert.deepEqual(
    rows('SELECT role FROM cms_account_role WHERE account_id = ? ORDER BY role', account.id).map((row) => row.role),
    ['advertiser'],
  );

  // Both writes went to the control plane's audit table under the promised action name.
  const db = new Database(fixture.controlDb);
  try {
    const entries = db
      .prepare("SELECT target_id, after_json FROM audit_log WHERE action = 'admin.account.role' ORDER BY id")
      .all() as { target_id: string; after_json: string }[];
    const mine = entries.filter((entry) => entry.target_id === String(account.id));
    assert.equal(mine.length, 2, 'one grant and one revocation, and no row for the no-op');
    assert.deepEqual(JSON.parse(mine[0]?.after_json ?? '{}'), { op: 'grant', role: 'advertiser', roles: ['advertiser', 'applicant'] });
    assert.deepEqual(JSON.parse(mine[1]?.after_json ?? '{}'), { op: 'revoke', role: 'applicant', roles: ['advertiser'] });
  } finally {
    db.close();
  }
});

test('S9-12. revoking the last role is refused by name, and the role stays', async () => {
  const account = rows('SELECT id FROM cms_account WHERE email = ?', LASTROLE)[0] as { id: number };
  const res = await post(`/admin/t/acme/accounts/${account.id}/roles`, { role: 'advertiser', op: 'revoke' });
  assert.equal(res.status, 400, res.body);
  assert.match(res.body, /cannot revoke advertiser from lastrole@acme\.test: it is the account&#39;s last role/);
  assert.match(res.body, /an account with no role cannot do anything/);
  assert.deepEqual(
    rows('SELECT role FROM cms_account_role WHERE account_id = ?', account.id).map((row) => row.role),
    ['advertiser'],
  );
});

test('S9-13. a role outside the closed vocabulary is refused', async () => {
  const account = rows('SELECT id FROM cms_account WHERE email = ?', ROLES)[0] as { id: number };
  const res = await post(`/admin/t/acme/accounts/${account.id}/roles`, { role: 'admin', op: 'grant' });
  assert.equal(res.status, 400, res.body);
  assert.equal(codeOf(res), 'SKW_E_PLT_REQUEST_INVALID');
  assert.match(res.body, /role must be one of applicant, advertiser/);
});

// --- 5. the two refusals every POST owes ------------------------------------

test('S9-14. a POST with no CSRF token is refused before anything is written', async () => {
  const account = rows('SELECT id FROM cms_account WHERE email = ?', NEWBIE)[0] as { id: number };
  const res = await post(`/admin/t/acme/accounts/${account.id}/status`, { status: 'closed' }, { csrf: null });
  assert.equal(res.status, 403, res.body);
  assert.equal(codeOf(res), 'SKW_E_SEC_CSRF');
  assert.equal((rows('SELECT status FROM cms_account WHERE id = ?', account.id)[0] as { status: string }).status, 'pending');

  const wrong = await post(`/admin/t/acme/accounts/${account.id}/roles`, { role: 'advertiser', op: 'grant' }, { csrf: 'not-a-token' });
  assert.equal(wrong.status, 403, wrong.body);
  assert.equal(codeOf(wrong), 'SKW_E_SEC_CSRF');
  assert.deepEqual(
    rows('SELECT role FROM cms_account_role WHERE account_id = ?', account.id).map((row) => row.role),
    ['applicant'],
  );
});

test('S9-15. a POST from another origin is refused on both writes', async () => {
  const account = rows('SELECT id FROM cms_account WHERE email = ?', NEWBIE)[0] as { id: number };
  for (const path of [`/admin/t/acme/accounts/${account.id}/status`, `/admin/t/acme/accounts/${account.id}/roles`]) {
    const res = await post(path, { status: 'closed', role: 'advertiser', op: 'grant' }, { origin: 'https://evil.test' });
    assert.equal(res.status, 403, `${path}: ${res.body}`);
    assert.equal(codeOf(res), 'SKW_E_SEC_CSRF');
  }
  assert.equal((rows('SELECT status FROM cms_account WHERE id = ?', account.id)[0] as { status: string }).status, 'pending');
});

test('S9-16. no account page prints a password hash or a TOTP secret, in any state', async () => {
  const ids = rows('SELECT id FROM cms_account').map((row) => row.id as number);
  const pages = [await get('/admin/t/acme/accounts'), ...(await Promise.all(ids.map((id) => get(`/admin/t/acme/accounts/${id}`))))];
  for (const res of pages) {
    assert.equal(res.status, 200, res.body);
    assert.doesNotMatch(res.body, /password_hash/);
    assert.doesNotMatch(res.body, /totp_secret/);
    assert.ok(!res.body.includes('LEAKCANARY'), 'a secret marker reached an account page');
  }
});
