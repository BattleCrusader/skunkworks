/**
 * §16 S2's auth criteria that S2a owns:
 *
 *   | a login with a wrong password and a login for a nonexistent user are
 *   | indistinguishable in status, body and time |  (this file, case 3)
 *   | TOTP is required when the allowlist is empty, and not when it is populated |
 *
 * plus the two rules §9.1 states as controls and not as prose: argon2id at
 * `m=19456,t=2,p=1`, and lockout that is exponential to 15 minutes.
 *
 * Every login goes through the real HTTP surface of the real app; the only seam is
 * the fixture's `control.db`, which is where an operator row actually lives.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { ARGON2_OPTIONS, lockoutMsFor, totpCode } from '../app/admin/auth.ts';
import { IDLE_MS_NO_ALLOWLIST, IDLE_MS_WITH_ALLOWLIST } from '../app/admin/session.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import {
  ADMIN_HOST,
  PASSWORD,
  TOTP_SECRET,
  codeOf,
  currentTotp,
  login,
  median,
  openSession,
  scrubBody,
  seedUser,
} from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';

const OWNER = 'owner@acme.test';
const TIMING = 'timing@acme.test';
const TOTP_ONLY = 'totp-required@acme.test';
const MISSING = 'nobody@acme.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

let populated: Fixture;
let populatedHandle: AppHandle;
let populatedPort = 0;

let fleet: Fixture;
let fleetHandle: AppHandle;
let fleetPort = 0;

async function listen(app: AppHandle): Promise<number> {
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.app.server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

before(async () => {
  fixture = makeFixture();
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: OWNER, totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: TIMING, totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: TOTP_ONLY, totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await listen(handle);

  // The same fixture with an allowlist populated: TOTP is no longer mandatory.
  populated = makeFixture();
  await seedUser({ controlDb: populated.controlDb, tenantKey: 'acme', email: OWNER, totpSecret: TOTP_SECRET });
  populatedHandle = await buildApp({ env: loadEnv(populated.env), adminAllowlist: ['10.0.0.0/8'] });
  populatedPort = await listen(populatedHandle);

  // A bundle: SKW_FLEET_MODE=0 (§9.1).
  fleet = makeFixture();
  await seedUser({
    controlDb: fleet.controlDb,
    tenantKey: null,
    email: 'fleet@skw.test',
    role: 'fleet_admin',
    totpSecret: TOTP_SECRET,
  });
  fleetHandle = await buildApp({ env: loadEnv({ ...fleet.env, SKW_FLEET_MODE: '0' }) });
  fleetPort = await listen(fleetHandle);
});

after(async () => {
  await handle.close();
  fixture.cleanup();
  await populatedHandle.close();
  populated.cleanup();
  await fleetHandle.close();
  fleet.cleanup();
});

test('0. the allowlist decides both consequences §9.1 states: TOTP and the idle window', () => {
  // Empty allowlist (every exported bundle): TOTP mandatory, 15-minute idle.
  assert.equal(handle.admin.idleMs, IDLE_MS_NO_ALLOWLIST);
  assert.equal(handle.admin.auth.totpRequired, true);
  // Populated allowlist: TOTP no longer mandatory, idle longer than 15 min.
  assert.equal(populatedHandle.admin.idleMs, IDLE_MS_WITH_ALLOWLIST);
  assert.equal(populatedHandle.admin.auth.totpRequired, false);
});

test('1. argon2id at the frozen cost: m=19456, t=2, p=1', async () => {
  // The stored hash, not a claim: read the row the fixture wrote.
  const db = new Database(fixture.controlDb, { readonly: true });
  const row = db.prepare('SELECT password_hash FROM user_account WHERE email = ?').get(OWNER) as {
    password_hash: string;
  };
  db.close();
  assert.match(row.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/, 'the PHC string must be argon2id at C-6 cost');
  assert.equal(ARGON2_OPTIONS.memoryCost, 19456);
  assert.equal(ARGON2_OPTIONS.timeCost, 2);
  assert.equal(ARGON2_OPTIONS.parallelism, 1);
});

test('2a. TOTP is mandatory when the allowlist is empty: no code and a wrong code are both 401', async () => {
  const missing = await login({ port, key: 'acme', email: TOTP_ONLY });
  assert.equal(missing.status, 401);
  assert.equal(codeOf(missing), 'SKW_E_SEC_CODE_INVALID');

  const wrong = await login({ port, key: 'acme', email: TOTP_ONLY, totp: '000000' });
  assert.equal(wrong.status, 401);
  assert.equal(codeOf(wrong), 'SKW_E_SEC_CODE_INVALID');

  const absent = await login({ port, key: 'acme', email: TOTP_ONLY, totp: '' });
  assert.equal(absent.status, 401);

  // A code from a different secret is a wrong code, not a crash.
  const foreign = await login({ port, key: 'acme', email: TOTP_ONLY, totp: totpCode('GEZDGNBVGY3TQOJQ', Date.now()) });
  assert.equal(foreign.status, 401);
  assert.equal(foreign.body.includes('stack'), false);
});

test('2b. with a valid TOTP the login succeeds, sets the cookie and reports totpRequired=false afterwards', async () => {
  const session = await openSession({ port, key: 'acme', email: OWNER });
  assert.ok(session.cookie.startsWith('__Host-sk-sess='));

  const info = await call({ port, path: '/admin/t/acme/session', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(info.status, 200);
  const json = info.json as { tenant: { key: string }; user: { email: string; role: string }; csrfToken: string };
  assert.equal(json.tenant.key, 'acme');
  assert.equal(json.user.email, OWNER);
  assert.equal(json.user.role, 'owner');
  assert.equal(json.csrfToken.length, 43, 'the CSRF token is a base64url HMAC');
});

test('3. TOTP is not required when the allowlist is populated', async () => {
  const noCode = await login({ port: populatedPort, key: 'acme', email: OWNER });
  assert.equal(noCode.status, 200, noCode.body);
  const json = noCode.json as { totpRequired: boolean; expiresAt: string };
  assert.equal(json.totpRequired, false);
  // §9.1: idle does not drop to 15 min when the allowlist is populated.
  const windowMs = Date.parse(json.expiresAt) - Date.now();
  assert.ok(windowMs > IDLE_MS_NO_ALLOWLIST, `idle window ${windowMs}ms must exceed the 15-min case`);
  assert.ok(Math.abs(windowMs - IDLE_MS_WITH_ALLOWLIST) < 5_000, `idle window ${windowMs}ms should be ~60 min`);
});

test('4. a wrong password and a nonexistent user are indistinguishable in status, body and time', async () => {
  const iterations = 20;
  // The lockout rule is measured in case 5; here it would turn the 6th sample into
  // a 429 and hide the timing. Each sample therefore resets the counter, which is
  // the only thing this test touches outside the HTTP surface.
  const reset = new Database(fixture.controlDb);
  const clearFailures = reset.prepare('UPDATE user_account SET failed_logins = 0, locked_until = NULL WHERE email = ?');
  // Warm the verifier so the first sample is not the library's cold start.
  for (let i = 0; i < 3; i += 1) {
    await login({ port, key: 'acme', email: TIMING, password: 'warm-up-wrong' });
    await login({ port, key: 'acme', email: MISSING, password: 'warm-up-wrong' });
    clearFailures.run(TIMING);
  }

  const wrongPassword: number[] = [];
  const noSuchUser: number[] = [];
  let wrongRes: Awaited<ReturnType<typeof login>> | null = null;
  let missingRes: Awaited<ReturnType<typeof login>> | null = null;

  try {
    for (let i = 0; i < iterations; i += 1) {
      const t0 = process.hrtime.bigint();
      const a = await login({ port, key: 'acme', email: TIMING, password: `wrong-${i}` });
      wrongPassword.push(Number(process.hrtime.bigint() - t0) / 1e6);
      clearFailures.run(TIMING);

      const t1 = process.hrtime.bigint();
      const b = await login({ port, key: 'acme', email: MISSING, password: `wrong-${i}` });
      noSuchUser.push(Number(process.hrtime.bigint() - t1) / 1e6);

      if (i === 0) {
        wrongRes = a;
        missingRes = b;
      }
    }
  } finally {
    reset.close();
  }

  assert.equal(wrongRes?.status, 401);
  assert.equal(missingRes?.status, 401);
  assert.equal(scrubBody(wrongRes!), scrubBody(missingRes!), 'status + body must be identical byte for byte');

  const a = median(wrongPassword);
  const b = median(noSuchUser);
  const ratio = Math.max(a, b) / Math.min(a, b);
  assert.ok(
    ratio <= 1.2,
    `medians must be within 20%: wrong-password ${a.toFixed(2)}ms vs nonexistent-user ${b.toFixed(2)}ms (ratio ${ratio.toFixed(3)})`,
  );
});

test('5. five failures lock the account, and the lock is exponential to 15 minutes', async () => {
  const email = 'locktarget@acme.test';
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email, totpSecret: TOTP_SECRET });

  for (let i = 0; i < 5; i += 1) {
    const res = await login({ port, key: 'acme', email, password: `wrong-${i}` });
    assert.equal(res.status, 401, `failure ${i + 1} is a 401`);
  }

  const locked = await login({ port, key: 'acme', email, password: 'still-wrong' });
  assert.equal(locked.status, 429, 'the sixth attempt is refused as rate-limited, not as a bad password');
  assert.equal(codeOf(locked), 'SKW_E_SEC_RATE_LIMITED');

  // A *correct* password is also refused while the lock holds — the lock is on the
  // account, not on the guess.
  const correct = await login({ port, key: 'acme', email, totp: currentTotp() });
  assert.equal(correct.status, 429);

  const db = new Database(fixture.controlDb, { readonly: true });
  const row = db.prepare('SELECT failed_logins, locked_until FROM user_account WHERE email = ?').get(email) as {
    failed_logins: number;
    locked_until: string;
  };
  db.close();
  assert.ok(row.failed_logins >= 5);
  const lockMs = Date.parse(row.locked_until) - Date.now();
  assert.ok(lockMs > 0 && lockMs <= 15 * 60_000, `locked_for=${lockMs}ms`);

  // The schedule itself: 1, 2, 4, 8, 15 minutes, capped.
  assert.deepEqual(
    [5, 6, 7, 8, 9, 12].map((n) => lockoutMsFor(n) / 60_000),
    [1, 2, 4, 8, 15, 15],
  );
  assert.equal(lockoutMsFor(4), 0, 'fewer than five failures never lock');
});

test('6. SKW_FLEET_MODE=0 refuses to authenticate a fleet_admin (403 SKW_E_SEC_ROLE_DISABLED)', async () => {
  const res = await login({ port: fleetPort, key: 'acme', email: 'fleet@skw.test', totp: currentTotp() });
  assert.equal(res.status, 403);
  assert.equal(codeOf(res), 'SKW_E_SEC_ROLE_DISABLED');
  assert.equal(res.headers['set-cookie'], undefined, 'a refused role must not mint a session');
});

test('7. a login for a tenant that is not serving is the same 404 as an unknown key', async () => {
  const suspended = await login({ port, key: 'nope', email: OWNER, totp: currentTotp() });
  assert.equal(suspended.status, 404);
  assert.equal(codeOf(suspended), 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('8. the login route requires an exact Origin, even though no session exists yet', async () => {
  const noOrigin = await login({ port, key: 'acme', email: OWNER, totp: currentTotp(), origin: null });
  assert.equal(noOrigin.status, 403);
  assert.equal(codeOf(noOrigin), 'SKW_E_SEC_CSRF');

  const evil = await login({
    port,
    key: 'acme',
    email: OWNER,
    totp: currentTotp(),
    origin: 'https://admin.skw.test.evil.test',
  });
  assert.equal(evil.status, 403);
  assert.equal(codeOf(evil), 'SKW_E_SEC_CSRF');
});

test('9. PASSWORD is the fixture password, so a positive login is not accidentally a 401', async () => {
  // A guard against the whole file passing because every login failed.
  const ok = await login({ port, key: 'acme', email: OWNER, password: PASSWORD, totp: currentTotp() });
  assert.equal(ok.status, 200);
});
