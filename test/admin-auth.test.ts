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
  assert.equal(codeOf(missing), 'SKW_E_SEC_AUTH_INVALID');

  const wrong = await login({ port, key: 'acme', email: TOTP_ONLY, totp: '000000' });
  assert.equal(wrong.status, 401);
  assert.equal(codeOf(wrong), 'SKW_E_SEC_AUTH_INVALID');

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

test('4. three login failure causes are indistinguishable in status, body and time', async () => {
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
    await login({ port, key: 'acme', email: TOTP_ONLY, totp: '000000' });
    clearFailures.run(TIMING);
    clearFailures.run(TOTP_ONLY);
  }

  const wrongPassword: number[] = [];
  const noSuchUser: number[] = [];
  const wrongTotp: number[] = [];
  let wrongRes: Awaited<ReturnType<typeof login>> | null = null;
  let missingRes: Awaited<ReturnType<typeof login>> | null = null;
  let totpRes: Awaited<ReturnType<typeof login>> | null = null;

  try {
    for (let i = 0; i < iterations; i += 1) {
      const t0 = process.hrtime.bigint();
      const a = await login({ port, key: 'acme', email: TIMING, password: `wrong-${i}` });
      wrongPassword.push(Number(process.hrtime.bigint() - t0) / 1e6);
      clearFailures.run(TIMING);

      const t1 = process.hrtime.bigint();
      const b = await login({ port, key: 'acme', email: MISSING, password: `wrong-${i}` });
      noSuchUser.push(Number(process.hrtime.bigint() - t1) / 1e6);

      // E-16: the third cause. A right password and a wrong TOTP.
      const t2 = process.hrtime.bigint();
      const c = await login({ port, key: 'acme', email: TOTP_ONLY, totp: '000000' });
      wrongTotp.push(Number(process.hrtime.bigint() - t2) / 1e6);
      clearFailures.run(TOTP_ONLY);

      if (i === 0) {
        wrongRes = a;
        missingRes = b;
        totpRes = c;
      }
    }
  } finally {
    reset.close();
  }

  for (const [name, res] of [['wrong password', wrongRes], ['unknown email', missingRes], ['wrong totp', totpRes]] as const) {
    assert.equal(res?.status, 401, name);
    assert.equal(codeOf(res!), 'SKW_E_SEC_AUTH_INVALID', `${name} must carry the E-16 code`);
  }

  // One code, one status, one body — after requestId is substituted, all three are
  // byte-identical. The message is the fixed literal, produced at the call site.
  const scrubbed = [wrongRes!, missingRes!, totpRes!].map((r) => scrubBody(r));
  assert.equal(scrubbed[0], scrubbed[1], 'wrong password vs unknown email');
  assert.equal(scrubbed[0], scrubbed[2], 'wrong password vs wrong TOTP');
  assert.match(scrubbed[0]!, /"message":"invalid credentials"/);

  const medians = {
    wrong_password: median(wrongPassword),
    unknown_email: median(noSuchUser),
    wrong_totp: median(wrongTotp),
  };
  const values = Object.values(medians);
  const ratio = Math.max(...values) / Math.min(...values);
  assert.ok(
    ratio <= 1.2,
    `medians across the three causes must be within 20%: ${JSON.stringify(medians)} (ratio ${ratio.toFixed(3)})`,
  );
});

test('4b. E-16: the work an attempt does is a function of configuration only, not of the credentials', async () => {
  // With TOTP mandatory, exactly one TOTP verification runs on every attempt —
  // against the row's secret, or against a fixed dummy secret when the row has
  // none — and it runs before the password verdict is used. So "the password was
  // right, because a TOTP step then ran" is not observable.
  const before = handle.admin.auth.totpComputations;
  await login({ port, key: 'acme', email: OWNER, totp: currentTotp() });                    // success
  await login({ port, key: 'acme', email: TIMING, password: 'wrong' });                     // wrong password
  await login({ port, key: 'acme', email: MISSING, password: 'wrong' });                    // unknown email
  await login({ port, key: 'acme', email: TOTP_ONLY, totp: '000000' });                     // wrong TOTP
  const mandatory = handle.admin.auth.totpComputations - before;
  assert.equal(mandatory, 4, 'one TOTP verification per attempt when TOTP is mandatory');

  // With the allowlist populated, none runs at all — the count depends on
  // `totpRequired` and on nothing else.
  const beforePopulated = populatedHandle.admin.auth.totpComputations;
  await login({ port: populatedPort, key: 'acme', email: OWNER });
  await login({ port: populatedPort, key: 'acme', email: MISSING, password: 'wrong' });
  assert.equal(populatedHandle.admin.auth.totpComputations - beforePopulated, 0, 'no TOTP work when it is optional');
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

test('7. a login for an operator whose tenant is not serving is the row-9 404 (§5.3)', async () => {
  // D29 removed the tenant key from the login URL, so "the key does not exist" is
  // no longer a login case. The reachable case is real: the row's tenant is
  // suspended, so the credentials may be right and the surface still has no tenant.
  const beta = 'owner@beta.test';
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'beta', email: beta, totpSecret: TOTP_SECRET });
  const db = new Database(fixture.controlDb);
  db.prepare("UPDATE tenant SET status = 'suspended' WHERE key = 'beta'").run();
  db.close();

  const res = await login({ port, email: beta, totp: currentTotp() });
  assert.equal(res.status, 404);
  assert.equal(codeOf(res), 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(res.headers['set-cookie'], undefined, 'a suspended tenant mints no session');
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
