/**
 * The login path after `ix_user_email`: an index that makes the lookup a SEARCH
 * without changing what the lookup *means*.
 *
 * Before the index slice `user_account(email)` had one index,
 * `ux_user_email_global ON user_account(email) WHERE tenant_id IS NULL` — partial,
 * and therefore usable only for the fleet operator. Every tenant admin login ran
 * `WHERE email = ?` as a full table scan (see `test/index-audit.test.ts`).
 *
 * The index added is **non-unique on purpose**. A UNIQUE index would move a decision
 * into SQLite that belongs to the app: the second `INSERT` would fail with a
 * constraint error at provisioning time, and `UNIQUE(tenant_id, email)` already says
 * the only uniqueness the schema believes in is *per tenant*.
 *
 * **D37 SUPERSEDES THE AMBIGUITY HALF OF THIS FILE.** It used to assert that two rows
 * with one email authenticate nothing, because there was one admin surface and one
 * email namespace, so the request was ambiguous and the answer was the 401 that says
 * nothing. D37 put `/admin` on each tenant host and made the Host the scope of the
 * credential lookup, so the two rows are no longer one ambiguous operand — they are
 * one operator per tenant, and each host authenticates its own. That is not a
 * weakening of the refusal: ambiguity is still refused *inside* a scope (the code and
 * its `ambiguous` reason are still there, and `UNIQUE(tenant_id,email)` is what makes
 * it unreachable today), and the wire still distinguishes nothing. What changed is
 * which side of the comparison the tenant comes from. The old assertion is replaced
 * below, in the same place, by the new one.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { Auth } from '../app/admin/auth.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { PASSWORD, TOTP_SECRET, currentTotp, login, scrubBody, seedUser } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';

const SHARED = 'shared@acme.test';
const MISSING = 'nobody@acme.test';
const ACME_HOST = 'acme.test';
const BETA_HOST = 'beta.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let auth: Auth;
let acmeRow = { id: 0, tenantId: 0 };
let betaRow = { id: 0, tenantId: 0 };

before(async () => {
  fixture = makeFixture({
    specs: [
      { key: 'acme', hosts: [ACME_HOST] },
      { key: 'beta', hosts: [BETA_HOST] },
    ],
  });
  // The same email in two tenants. `UNIQUE(tenant_id, email)` permits it, and D37 is
  // what makes it usable: without a Host scope this row pair could not authenticate.
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: SHARED, totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'beta', email: SHARED, totpSecret: TOTP_SECRET });
  const db = new Database(fixture.controlDb, { readonly: true });
  try {
    const rows = db.prepare('SELECT id, tenant_id FROM user_account WHERE email = ? ORDER BY tenant_id').all(SHARED) as {
      id: number;
      tenant_id: number;
    }[];
    acmeRow = { id: rows[0]?.id ?? 0, tenantId: rows[0]?.tenant_id ?? 0 };
    betaRow = { id: rows[1]?.id ?? 0, tenantId: rows[1]?.tenant_id ?? 0 };
  } finally {
    db.close();
  }

  auth = new Auth({
    controlPath: fixture.controlDb,
    fleetMode: true,
    // A populated allowlist means TOTP is not mandatory, so the password is the
    // only credential in play and a refusal can only be about the row.
    allowlist: ['10.0.0.0/8'],
  });

  handle = await buildApp({
    env: loadEnv({ ...fixture.env, SKW_ADMIN_ALLOWLIST: '10.0.0.0/8' }),
  });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
});

test('two rows with one email are storable — the index is not a uniqueness constraint', () => {
  const db = new Database(fixture.controlDb, { readonly: true });
  try {
    const rows = db.prepare('SELECT tenant_id FROM user_account WHERE email = ?').all(SHARED) as {
      tenant_id: number | null;
    }[];
    assert.equal(rows.length, 2, 'both tenants hold the shared email');
    assert.deepEqual(
      rows.map((r) => r.tenant_id).sort(),
      [1, 2],
    );
    const indexes = db.prepare("PRAGMA index_list('user_account')").all() as { name: string; unique: number }[];
    const email = indexes.find((i) => i.name === 'ix_user_email');
    assert.ok(email !== undefined, 'ix_user_email is missing');
    assert.equal(email.unique, 0, "ix_user_email must be non-unique (ambiguity is the app's refusal, not the schema's)");
  } finally {
    db.close();
  }
});

test('D37 (was: an ambiguous email authenticates nothing) — the scope decides, and each scope gets its own row', async () => {
  // The old test asserted one 401 for both rows. The new promise: the scope is the
  // Host's tenant, so each lookup sees exactly one row and authenticates it.
  const onAcme = await auth.authenticate({
    scope: acmeRow.tenantId,
    email: SHARED,
    password: PASSWORD,
    totp: undefined,
    atMs: Date.now(),
  });
  assert.equal(onAcme.ok, true, "acme's row authenticates in acme's scope");
  if (!onAcme.ok) return;
  assert.equal(onAcme.user.id, acmeRow.id);
  assert.equal(onAcme.user.tenantId, acmeRow.tenantId);

  const onBeta = await auth.authenticate({
    scope: betaRow.tenantId,
    email: SHARED,
    password: PASSWORD,
    totp: undefined,
    atMs: Date.now(),
  });
  assert.equal(onBeta.ok, true, "beta's row authenticates in beta's scope");
  if (!onBeta.ok) return;
  assert.equal(onBeta.user.id, betaRow.id);
  assert.equal(onBeta.user.tenantId, betaRow.tenantId);
  assert.notEqual(onAcme.user.id, onBeta.user.id, 'two rows, two operators');

  // The fleet scope sees neither: a fleet operator has `tenant_id IS NULL`, and a
  // tenant row is not a fleet row.
  const onFleet = await auth.authenticate({ scope: null, email: SHARED, password: PASSWORD, totp: undefined, atMs: Date.now() });
  assert.equal(onFleet.ok, false);
  if (onFleet.ok) return;
  assert.equal(onFleet.reason, 'unknown_user', 'a tenant row is not in the fleet scope');
  assert.equal(onFleet.error.code, 'SKW_E_SEC_AUTH_INVALID');
  assert.equal(onFleet.error.status, 401);
});

test('the wire still distinguishes nothing: a wrong password and an unknown email are one answer', async () => {
  const wrong = await login({ port, email: SHARED, password: 'not-the-password', totp: currentTotp(), host: ACME_HOST });
  const unknown = await login({ port, email: MISSING, password: PASSWORD, totp: currentTotp(), host: ACME_HOST });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(scrubBody(wrong), scrubBody(unknown));
  assert.doesNotMatch(wrong.body, /ambiguous|two|tenant/i, 'the body must not say why');
});

test('a single-row email still logs in after the index (the index is not a refusal)', async () => {
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'solo@acme.test', totpSecret: TOTP_SECRET });
  const res = await login({ port, email: 'solo@acme.test', password: PASSWORD, host: ACME_HOST });
  assert.equal(res.status, 200, `a unique email must still authenticate: ${res.body}`);
  const body = res.json as { ok?: boolean; csrfToken?: unknown };
  assert.equal(body.ok, true);
  assert.equal(typeof body.csrfToken, 'string', 'a successful login mints a CSRF token');
});

test('the plan of the login statement is a SEARCH through ix_user_email', () => {
  const db = new Database(fixture.controlDb, { readonly: true });
  try {
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT id, tenant_id, email, password_hash, role, totp_secret, failed_logins, locked_until
               FROM user_account WHERE email = ?`,
        )
        .all(SHARED) as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');
    assert.match(plan, /^SEARCH user_account USING INDEX ix_user_email \(email=\?\)/, plan);
    assert.doesNotMatch(plan, /\bSCAN\b/, plan);
  } finally {
    db.close();
  }
});
