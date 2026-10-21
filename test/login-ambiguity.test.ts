/**
 * The login path after `ix_user_email`: an index that makes the lookup a SEARCH
 * without changing what the lookup *means*.
 *
 * Before this slice `user_account(email)` had one index,
 * `ux_user_email_global ON user_account(email) WHERE tenant_id IS NULL` — partial,
 * and therefore usable only for the fleet operator. Every tenant admin login ran
 * `WHERE email = ?` as a full table scan (see `test/index-audit.test.ts`).
 *
 * The index added is **non-unique on purpose**. `Auth.authenticate()` refuses two
 * rows with one email as *ambiguous* — the same 401 as a wrong password, so the
 * response is not an oracle that says "this email exists twice". A UNIQUE index
 * would move that decision into SQLite: the second `INSERT` would fail with a
 * constraint error at provisioning time, and a login could never see the case the
 * code is written to handle. The semantics are the app's, so the index must not
 * assert them.
 *
 * This file is the witness that both halves still hold: the index exists and is
 * not unique, and the ambiguity refusal still names its reason after it.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { Auth } from '../app/admin/auth.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { PASSWORD, TOTP_SECRET, login, scrubBody, seedUser } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';

const SHARED = 'shared@acme.test';
const MISSING = 'nobody@acme.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let auth: Auth;

before(async () => {
  fixture = makeFixture({
    specs: [
      { key: 'acme', hosts: ['acme.test'] },
      { key: 'beta', hosts: ['beta.test'] },
    ],
  });
  // The same email in two tenants. Before the index this INSERT already succeeded
  // (UNIQUE(tenant_id, email) permits it); it must still succeed with the index in
  // place, or the index has taken over a decision that belongs to `authenticate()`.
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: SHARED, totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'beta', email: SHARED, totpSecret: TOTP_SECRET });

  auth = new Auth({
    controlPath: fixture.controlDb,
    fleetMode: true,
    // A populated allowlist means TOTP is not mandatory, so the password is the
    // only credential in play and the refusal can only be the ambiguity.
    allowlist: ['10.0.0.0/8'],
  });

  handle = await buildApp({
    // A populated allowlist means TOTP is not mandatory — the same configuration
    // the direct `Auth` above uses, so the HTTP case and the unit case agree.
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

test('an ambiguous email still authenticates nothing, and the server reason is `ambiguous`', async () => {
  const result = await auth.authenticate({
    email: SHARED,
    // The correct password of both rows: the refusal must not be a password failure.
    password: PASSWORD,
    totp: undefined,
    atMs: Date.now(),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'ambiguous', 'two rows, one email: the reason is the ambiguity');
  assert.equal(result.error.code, 'SKW_E_SEC_AUTH_INVALID');
  assert.equal(result.error.status, 401);
});

test('the wire does not distinguish an ambiguous email from an unknown one', async () => {
  const ambiguous = await login({ port, email: SHARED, password: PASSWORD });
  const unknown = await login({ port, email: MISSING, password: PASSWORD });
  assert.equal(ambiguous.status, 401);
  assert.equal(unknown.status, 401);
  // Same code and no detail that differs. `requestId` is per-request by design.
  assert.equal(scrubBody(ambiguous), scrubBody(unknown));
  assert.doesNotMatch(ambiguous.body, /ambiguous|two|tenant/i, 'the body must not say why');
});

test('a single-row email still logs in after the index (the index is not a refusal)', async () => {
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'solo@acme.test', totpSecret: TOTP_SECRET });
  const res = await login({ port, email: 'solo@acme.test', password: PASSWORD });
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
