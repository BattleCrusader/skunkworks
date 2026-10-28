/**
 * The sign-up state machine, exercised end to end against a real `site.db` built from `site.sql`.
 *
 * Every assertion here is about a transition that must not be skippable: pending cannot sign in,
 * email proof alone does not activate, a link works once, a duplicate address does not create a
 * second row, and a wrong password costs the same work as an unknown address.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Accounts, PASSWORD_MIN, hash64, tokenHash } from '../app/accounts/service.ts';
import { Semaphore, totpCode } from '../app/admin/auth.ts';
import type { Env } from '../app/env.ts';
import { SCHEMA } from './helpers/fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'skw-accounts-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** Only `ipHashKey` is read by this module; the rest of `Env` is the app's business. */
const ENV = { ipHashKey: 'accounts-test-ip-hash-key-0123456789' } as Env;

function tenantDb(name: string): string {
  const path = join(root, name, 'site.db');
  mkdirSync(join(root, name), { recursive: true });
  // A second harness for the same key means "the same tenant, later in the day", not a new file.
  if (existsSync(path)) return path;
  const handle = new Database(path);
  handle.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
  handle.close();
  return path;
}

interface Harness {
  accounts: Accounts;
  open(): Database.Database;
  log: { event: string } & Record<string, unknown> extends never ? never : Record<string, unknown>[];
  clock: { ms: number };
}

let nextKey = 0;
/** Each test gets its own tenant unless it names one: two tests in one database is a shared fixture. */
function harness(key = `tenant-auto-${(nextKey += 1)}`): Harness {
  const path = tenantDb(key);
  const log: Record<string, unknown>[] = [];
  const clock = { ms: Date.parse('2026-10-27T00:00:00.000Z') };
  const accounts = new Accounts({
    env: ENV,
    openDb: () => new Database(path),
    argon: new Semaphore(4),
    now: () => clock.ms,
    log: (line) => log.push(line as unknown as Record<string, unknown>),
    exposeVerifyLink: true,
  });
  return { accounts, open: () => new Database(path), log, clock };
}

const IP = { ip: '203.0.113.9' };

async function registered(h: Harness, over: Record<string, unknown> = {}) {
  return h.accounts.register(
    {
      email: 'sam@example.test',
      password: 'correct horse battery staple',
      displayName: 'Sam Rivers',
      roles: ['applicant'],
      ...over,
    },
    'tenant-a',
    IP,
  );
}

/** The verification token, taken from the log line — which is the offline operator's only route. */
function tokenFrom(h: Harness): string {
  const line = h.log.find((l) => l.event === 'account.verify_link');
  assert.ok(line !== undefined, 'a registration must log its verification URL');
  return String(line.url).replace('/portal/verify?token=', '');
}

test('A1 — registration creates a pending account, its role, its profile and one outbox row', async () => {
  const h = harness();
  const result = await registered(h);
  assert.equal(result.kind, 'pending');
  if (result.kind !== 'pending') return;
  assert.match(result.totpGrouped, /^[A-Z2-7]{4}( [A-Z2-7]{4})+$/, 'the secret is shown grouped for typing');
  assert.match(result.otpauthUri, /^otpauth:\/\/totp\//);

  const db = h.open();
  try {
    const row = db.prepare('SELECT status, email, email_verified, totp_confirmed_at FROM cms_account').get() as {
      status: string;
      email: string;
      email_verified: number;
      totp_confirmed_at: string | null;
    };
    assert.equal(row.status, 'pending');
    assert.equal(row.email, 'sam@example.test');
    assert.equal(row.email_verified, 0);
    assert.equal(row.totp_confirmed_at, null);
    assert.deepEqual(
      (db.prepare('SELECT role FROM cms_account_role').all() as { role: string }[]).map((r) => r.role),
      ['applicant'],
    );
    assert.equal((db.prepare('SELECT display_name FROM cms_profile').get() as { display_name: string }).display_name, 'Sam Rivers');
    const mail = db.prepare('SELECT template, status FROM cms_mail').all() as { template: string; status: string }[];
    assert.deepEqual(mail, [{ template: 'verify_email', status: 'queued' }]);
    // The link is stored as a hash, never as the token.
    const stored = db.prepare('SELECT token_hash FROM cms_account_token').get() as { token_hash: string };
    assert.equal(stored.token_hash, tokenHash(tokenFrom(h)));
    assert.notEqual(stored.token_hash, tokenFrom(h));
  } finally {
    db.close();
  }
});

test('A2 — a pending account cannot sign in, even with the right password and code', async () => {
  const h = harness();
  const reg = await registered(h);
  if (reg.kind !== 'pending') throw new Error('unreachable');
  const db = h.open();
  let secret = '';
  try {
    secret = (db.prepare('SELECT totp_secret FROM cms_account').get() as { totp_secret: string }).totp_secret;
  } finally {
    db.close();
  }
  const out = await h.accounts.signIn(
    { email: 'sam@example.test', password: 'correct horse battery staple', code: totpCode(secret, h.clock.ms) },
    'tenant-a',
    IP,
  );
  assert.deepEqual(out, { ok: false, reason: 'credentials' }, 'the answer names nothing: not the state, not the credentials');
});

test('A3 — email proof alone leaves the account pending; the TOTP confirmation is what activates it', async () => {
  const h = harness();
  await registered(h);
  const first = h.accounts.verifyEmail(tokenFrom(h), 'tenant-a');
  assert.deepEqual(first, { ok: true, activated: false, next: 'confirm_totp' });

  const db = h.open();
  const accountId = (db.prepare('SELECT id FROM cms_account').get() as { id: number }).id;
  const secret = (db.prepare('SELECT totp_secret FROM cms_account').get() as { totp_secret: string }).totp_secret;
  db.close();

  assert.equal(h.accounts.confirmTotp(accountId, '000000', 'tenant-a').ok, false, 'a wrong code proves nothing');
  const good = h.accounts.confirmTotp(accountId, totpCode(secret, h.clock.ms), 'tenant-a');
  assert.deepEqual(good, { ok: true, activated: true });

  const after = h.open();
  try {
    assert.equal((after.prepare('SELECT status FROM cms_account').get() as { status: string }).status, 'active');
  } finally {
    after.close();
  }
});

test('A4 — the order does not matter: confirming TOTP first, then the link, still activates', async () => {
  const h = harness('tenant-b');
  await registered(h);
  const db = h.open();
  const accountId = (db.prepare('SELECT id FROM cms_account').get() as { id: number }).id;
  const secret = (db.prepare('SELECT totp_secret FROM cms_account').get() as { totp_secret: string }).totp_secret;
  db.close();

  assert.deepEqual(h.accounts.confirmTotp(accountId, totpCode(secret, h.clock.ms), 'tenant-b'), {
    ok: true,
    activated: false,
  });
  assert.deepEqual(h.accounts.verifyEmail(tokenFrom(h), 'tenant-b'), { ok: true, activated: true, next: 'active' });
});

test('A5 — a verification link works once, and an expired one never', async () => {
  const h = harness('tenant-c');
  await registered(h);
  const token = tokenFrom(h);
  assert.equal(h.accounts.verifyEmail(token, 'tenant-c').ok, true);
  assert.deepEqual(h.accounts.verifyEmail(token, 'tenant-c'), { ok: false, reason: 'consumed' });

  const h2 = harness('tenant-d');
  await registered(h2);
  const token2 = tokenFrom(h2);
  h2.clock.ms += 24 * 60 * 60_000 + 1;
  assert.deepEqual(h2.accounts.verifyEmail(token2, 'tenant-d'), { ok: false, reason: 'expired' });
});

test('A6 — a token minted for one tenant does not exist in another', async () => {
  const h = harness('tenant-e');
  await registered(h);
  const other = harness('tenant-f');
  assert.deepEqual(other.accounts.verifyEmail(tokenFrom(h), 'tenant-f'), { ok: false, reason: 'unknown' });
});

test('A7 — a second registration for the same address creates nothing and mails the owner', async () => {
  const h = harness('tenant-g');
  await registered(h);
  const again = await h.accounts.register(
    { email: 'SAM@example.test', password: 'another long password here', displayName: 'Someone Else', roles: ['advertiser'] },
    'tenant-g',
    IP,
  );
  assert.deepEqual(again, { kind: 'exists', mailed: true });
  const db = h.open();
  try {
    assert.equal((db.prepare('SELECT count(*) AS n FROM cms_account').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT count(*) AS n FROM cms_profile').get() as { n: number }).n, 1);
    assert.deepEqual(
      (db.prepare('SELECT template FROM cms_mail ORDER BY id').all() as { template: string }[]).map((m) => m.template),
      ['verify_email', 'account_exists'],
    );
  } finally {
    db.close();
  }
});

test('A8 — a short password is refused before anything is written', async () => {
  const h = harness('tenant-h');
  await assert.rejects(
    () => registered(h, { password: 'x'.repeat(PASSWORD_MIN - 1) }),
    /at least 12 characters/,
  );
  assert.equal(h.log.length, 0);
  const db = h.open();
  try {
    assert.equal((db.prepare('SELECT count(*) AS n FROM cms_account').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('A9 — sign-in: unknown address, wrong password and wrong code are one answer', async () => {
  const h = harness('tenant-i');
  const reg = await registered(h);
  if (reg.kind !== 'pending') throw new Error('unreachable');
  // Activate, then probe all three refusals against a real account.
  h.accounts.verifyEmail(tokenFrom(h), 'tenant-i');
  const db = h.open();
  const secret = (db.prepare('SELECT totp_secret FROM cms_account').get() as { totp_secret: string }).totp_secret;
  db.close();
  h.accounts.confirmTotp(reg.accountId, totpCode(secret, h.clock.ms), 'tenant-i');

  const code = () => totpCode(secret, h.clock.ms);
  const unknown = await h.accounts.signIn({ email: 'nobody@example.test', password: 'whatever long enough', code: code() }, 'tenant-i', IP);
  const badPass = await h.accounts.signIn({ email: 'sam@example.test', password: 'wrong password entirely', code: code() }, 'tenant-i', IP);
  const badCode = await h.accounts.signIn(
    { email: 'sam@example.test', password: 'correct horse battery staple', code: '000000' },
    'tenant-i',
    IP,
  );
  for (const out of [unknown, badPass, badCode]) {
    assert.deepEqual(out, { ok: false, reason: 'credentials' });
  }
});

test('A10 — a correct sign-in mints a session whose cookie value is not what the table stores', async () => {
  const h = harness('tenant-j');
  const reg = await registered(h);
  if (reg.kind !== 'pending') throw new Error('unreachable');
  h.accounts.verifyEmail(tokenFrom(h), 'tenant-j');
  const db = h.open();
  const secret = (db.prepare('SELECT totp_secret FROM cms_account').get() as { totp_secret: string }).totp_secret;
  db.close();
  h.accounts.confirmTotp(reg.accountId, totpCode(secret, h.clock.ms), 'tenant-j');

  const out = await h.accounts.signIn(
    { email: 'Sam@Example.TEST', password: 'correct horse battery staple', code: totpCode(secret, h.clock.ms) },
    'tenant-j',
    { ...IP, userAgent: 'test-agent' },
  );
  assert.equal(out.ok, true);
  if (out.ok !== true) return;
  assert.deepEqual(out.account.roles, ['applicant']);
  assert.equal(out.account.email, 'sam@example.test', 'the address is normalised on the way in');

  const check = h.open();
  try {
    const row = check.prepare('SELECT id, ip_hash, ua_hash FROM cms_account_session').get() as {
      id: string;
      ip_hash: string;
      ua_hash: string;
    };
    assert.equal(row.id, tokenHash(out.session.id));
    assert.notEqual(row.id, out.session.id);
    assert.equal(row.ip_hash, hash64(ENV.ipHashKey, IP.ip));
    assert.equal(row.ua_hash, hash64(ENV.ipHashKey, 'test-agent'));

    // The cookie resolves to the person, from the same address, and stops resolving from another.
    assert.equal(h.accounts.authenticate(out.session.id, 'tenant-j', IP)?.accountId, reg.accountId);
    assert.equal(h.accounts.authenticate(out.session.id, 'tenant-j', { ip: '198.51.100.4' }), null);
    assert.equal(h.accounts.authenticate('not-a-session', 'tenant-j', IP), null);

    h.accounts.signOut(out.session.id, 'tenant-j');
    assert.equal(h.accounts.authenticate(out.session.id, 'tenant-j', IP), null, 'sign-out takes effect immediately');
  } finally {
    check.close();
  }
});

test('A11 — five wrong passwords lock the account, and the lock is reported as such', async () => {
  const h = harness('tenant-k');
  const reg = await registered(h);
  if (reg.kind !== 'pending') throw new Error('unreachable');
  h.accounts.verifyEmail(tokenFrom(h), 'tenant-k');
  const db = h.open();
  const secret = (db.prepare('SELECT totp_secret FROM cms_account').get() as { totp_secret: string }).totp_secret;
  db.close();
  h.accounts.confirmTotp(reg.accountId, totpCode(secret, h.clock.ms), 'tenant-k');

  for (let i = 0; i < 5; i += 1) {
    const out = await h.accounts.signIn(
      { email: 'sam@example.test', password: 'wrong password entirely', code: totpCode(secret, h.clock.ms) },
      'tenant-k',
      IP,
    );
    assert.equal(out.ok === false ? out.reason : '', 'credentials');
  }
  const locked = await h.accounts.signIn(
    { email: 'sam@example.test', password: 'correct horse battery staple', code: totpCode(secret, h.clock.ms) },
    'tenant-k',
    IP,
  );
  assert.deepEqual(locked, { ok: false, reason: 'locked' });
});

test('A12 — sign-in is rate limited per address before any argon2 runs', async () => {
  const h = harness('tenant-l');
  const path = join(root, 'tenant-l', 'site.db');
  const limited = new Accounts({
    env: ENV,
    openDb: () => new Database(path),
    argon: new Semaphore(4),
    now: () => h.clock.ms,
    limits: { signin: 2, windowMs: 60_000 },
  });
  const attempt = () =>
    limited.signIn({ email: 'nobody@example.test', password: 'whatever long enough', code: '000000' }, 'tenant-l', IP);
  await attempt();
  await attempt();
  await assert.rejects(attempt, /too many attempts from this address/);
});

test('A13 — a session idle for more than an hour stops resolving', async () => {
  const h = harness('tenant-m');
  const reg = await registered(h);
  if (reg.kind !== 'pending') throw new Error('unreachable');
  h.accounts.verifyEmail(tokenFrom(h), 'tenant-m');
  const db = h.open();
  const secret = (db.prepare('SELECT totp_secret FROM cms_account').get() as { totp_secret: string }).totp_secret;
  db.close();
  h.accounts.confirmTotp(reg.accountId, totpCode(secret, h.clock.ms), 'tenant-m');
  const out = await h.accounts.signIn(
    { email: 'sam@example.test', password: 'correct horse battery staple', code: totpCode(secret, h.clock.ms) },
    'tenant-m',
    IP,
  );
  assert.equal(out.ok, true);
  if (out.ok !== true) return;
  h.clock.ms += 60 * 60_000 + 1;
  assert.equal(h.accounts.authenticate(out.session.id, 'tenant-m', IP), null);
});
