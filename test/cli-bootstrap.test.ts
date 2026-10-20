/**
 * E-19's gate — `skwctl admin bootstrap`, and the login it enables.
 *
 * The command is exercised as a **process**: `spawnSync(node, app/cli/skwctl.ts …)`
 * with a real environment and a real `control.db`. Nothing is imported and called
 * in-process, because the contract includes the exit code, the refusal on stderr
 * and the absence of a secret on stdout — none of which an in-process call can
 * demonstrate.
 *
 * The ten cases are E-19's list, in its order.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { hash } from '@node-rs/argon2';

import { ARGON2_OPTIONS, totpCode, verifyTotp } from '../app/admin/auth.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, cookiePair, login } from './helpers/admin.ts';
import { makeFixture, REPO, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';

const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function skwctl(env: Record<string, string>, args: readonly string[]): Run {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

interface Enrolment {
  uri: string;
  secret: string;
  password: string | undefined;
  email: string;
  adminUrl: string;
}

/** Parse the one artefact that is allowed to carry the secret. */
function enrolmentOf(path: string): Enrolment {
  const text = readFileSync(path, 'utf8');
  const field = (name: string): string => {
    const m = new RegExp(`^${name}:\\s+(.*)$`, 'm').exec(text);
    if (m === null) throw new Error(`the enrolment file has no ${name} line:\n${text}`);
    return m[1] as string;
  };
  return {
    uri: field('uri'),
    secret: field('secret').replace(/ /g, ''),
    password: /^password:/m.test(text) ? field('password') : undefined,
    email: field('email'),
    adminUrl: field('admin'),
  };
}

/**
 * The seed's claim marker: `must_change=1`, `totp_secret` NULL, and a real
 * argon2id hash of 32 random bytes discarded at export — a verification costs
 * exactly what a real one costs and can never succeed.
 */
async function seedClaimMarker(fixture: Fixture, tenantKey: string, email: string): Promise<void> {
  const discarded = (await import('node:crypto')).randomBytes(32).toString('hex');
  const hashOfDiscarded = await hash(discarded, ARGON2_OPTIONS);
  const db = new Database(fixture.controlDb);
  const tenant = db.prepare('SELECT id FROM tenant WHERE key = ?').get(tenantKey) as { id: number };
  db.prepare(
    `INSERT INTO user_account (tenant_id, email, password_hash, role, totp_secret, must_change)
     VALUES (?, ?, ?, 'owner', NULL, 1)`,
  ).run(tenant.id, email, hashOfDiscarded);
  db.close();
}

function userRow(fixture: Fixture, email: string): {
  id: number;
  password_hash: string;
  totp_secret: string | null;
  must_change: number;
  last_login_at: string | null;
} {
  const db = new Database(fixture.controlDb, { readonly: true });
  const row = db
    .prepare('SELECT id, password_hash, totp_secret, must_change, last_login_at FROM user_account WHERE email = ?')
    .get(email) as { id: number; password_hash: string; totp_secret: string | null; must_change: number; last_login_at: string | null };
  db.close();
  return row;
}

/**
 * Every text the database holds **except** `user_account.totp_secret`, which is the
 * one place a secret is supposed to live (§9.1's control table). Anything else —
 * `audit_log.after_json` above all — is a leak.
 */
function databaseText(fixture: Fixture): string {
  const db = new Database(fixture.controlDb, { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  let text = '';
  for (const { name } of tables) {
    try {
      if (name === 'user_account') {
        text += JSON.stringify(
          db.prepare('SELECT id, tenant_id, email, password_hash, role, must_change, reset_token_hash FROM user_account').all(),
        );
        continue;
      }
      text += JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
    } catch {
      /* a table this build cannot read is not an artefact it wrote */
    }
  }
  db.close();
  return text;
}

let fixture: Fixture;
let outDir: string;
let firstFile: string;
let first: Enrolment;
let handle: AppHandle;
let port = 0;

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], displayName: 'Acme' }] });
  await seedClaimMarker(fixture, 'acme', 'owner@acme.test');
  outDir = join(fixture.dir, 'enrolment');
  firstFile = join(outDir, 'first-login.txt');
});

after(async () => {
  if (handle !== undefined) await handle.close();
  fixture.cleanup();
});

test('1. a fresh seeded control.db and nothing else yields one operator, and a code from the printed URI logs in', async () => {
  const run = skwctl(fixture.env, ['admin', 'bootstrap', '--generate-password', '--enrolment-out', firstFile]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.includes('enrolment written'), true);
  // Stdout carries the path and the login URL only.
  assert.equal(run.stdout.includes('secret'), false, 'stdout must not name a secret');
  assert.equal(run.stdout.includes('password'), false, 'stdout must not carry the password');

  assert.equal(existsSync(firstFile), true);
  first = enrolmentOf(firstFile);
  assert.match(first.uri, /^otpauth:\/\/totp\//);

  // Exactly one operator, and it is the seeded owner.
  const db = new Database(fixture.controlDb, { readonly: true });
  const users = db.prepare('SELECT email, role, must_change, totp_secret FROM user_account').all() as {
    email: string;
    role: string;
    must_change: number;
    totp_secret: string | null;
  }[];
  db.close();
  assert.equal(users.length, 1);
  assert.equal(users[0]?.role, 'owner');
  assert.equal(users[0]?.must_change, 0);
  assert.equal(users[0]?.totp_secret, first.secret);

  // The end-to-end login: the generated password plus a code computed from the
  // secret in the printed URI, through the real login route.
  assert.ok(first.password !== undefined, 'bootstrap generates a password');
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;

  const login = await call({
    port,
    path: '/admin/login',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ email: first.email, password: first.password, totp: totpCode(first.secret, Date.now()) }),
  });
  assert.equal(login.status, 200, login.body);
  const cookie = cookiePair(login);
  assert.ok(cookie !== undefined, 'a successful login sets the session cookie');

  const console = await call({ port, path: '/admin', host: ADMIN_HOST, headers: { cookie: cookie as string } });
  assert.equal(console.status, 200, console.body);
  assert.match(String(console.headers['content-type']), /text\/html/);
});

test('10. the otpauth URI parses and its secret verifies a TOTP code', () => {
  const url = new URL(first.uri);
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.hostname, 'totp');
  assert.equal(decodeURIComponent(url.pathname), `/Skunkworks:${first.email}`);
  assert.equal(url.searchParams.get('issuer'), 'Skunkworks');
  assert.equal(url.searchParams.get('algorithm'), 'SHA1');
  assert.equal(url.searchParams.get('digits'), '6');
  assert.equal(url.searchParams.get('period'), '30');
  const secret = url.searchParams.get('secret');
  assert.equal(secret, first.secret);
  assert.match(String(secret), /^[A-Z2-7]{32}$/, '20 bytes as unpadded base32 is 32 characters');
  // 32 characters of base32 decode to 20 bytes.
  const code = totpCode(String(secret), Date.now());
  assert.match(code, /^[0-9]{6}$/);
  assert.equal(verifyTotp(String(secret), code, Date.now()), true);
  assert.equal(verifyTotp(String(secret), '000000', Date.now()), code === '000000');
});

test('2. a second run exits 3 and leaves password_hash, totp_secret and must_change byte-identical', async () => {
  const beforeRow = userRow(fixture, 'owner@acme.test');
  const secondFile = join(outDir, 'second-login.txt');
  const run = skwctl(fixture.env, ['admin', 'bootstrap', '--generate-password', '--enrolment-out', secondFile]);
  assert.equal(run.status, 3, `exit 3 is the only benign refusal; got ${run.status}\n${run.stderr}`);
  assert.match(run.stderr, /REFUSAL: ALREADY_BOOTSTRAPPED/);
  assert.match(run.stderr, /reset-totp/, 'the refusal names the command that would change it');
  assert.match(run.stderr, /reset-password/);
  assert.equal(existsSync(secondFile), false, 'a refused run writes no enrolment file');

  const afterRow = userRow(fixture, 'owner@acme.test');
  assert.equal(afterRow.password_hash, beforeRow.password_hash);
  assert.equal(afterRow.totp_secret, beforeRow.totp_secret);
  assert.equal(afterRow.must_change, beforeRow.must_change);

  // And the first credentials still work: the refusal did not rotate a secret it
  // did not create, which is the whole reason `--generate-password` is safe to
  // re-run from a script.
  const again = await login({
    port,
    email: first.email,
    password: first.password as string,
    totp: totpCode(first.secret, Date.now()),
  });
  assert.equal(again.status, 200, again.body);
});

test('3. a claimed user exits 3 and the file is not written', async () => {
  // "Claimed" by a real login rather than by bootstrap: last_login_at is set.
  const db = new Database(fixture.controlDb);
  db.prepare('UPDATE user_account SET last_login_at = ? WHERE email = ?').run(new Date().toISOString(), 'owner@acme.test');
  db.close();
  const path = join(outDir, 'claimed.txt');
  const run = skwctl(fixture.env, ['admin', 'bootstrap', '--enrolment-out', path]);
  assert.equal(run.status, 3, run.stderr);
  assert.equal(existsSync(path), false);
});

test('4. zero user rows with one production tenant creates one; two tenants and no --tenant refuses AMBIGUOUS_TARGET', async () => {
  const empty = makeFixture({ specs: [{ key: 'solo', hosts: ['solo.test'] }] });
  const path = join(empty.dir, 'solo.txt');
  const run = skwctl(empty.env, ['admin', 'bootstrap', '--enrolment-out', path]);
  assert.equal(run.status, 0, run.stderr);
  const created = enrolmentOf(path);
  const db = new Database(empty.controlDb, { readonly: true });
  const rows = db.prepare('SELECT email, role, tenant_id FROM user_account').all() as {
    email: string;
    role: string;
    tenant_id: number;
  }[];
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.role, 'owner');
  assert.equal(created.email, 'owner@localhost.invalid');

  // Two production tenants and no --tenant: the default fixture has acme and beta.
  const two = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }, { key: 'beta', hosts: ['beta.test'] }] });
  const twoPath = join(two.dir, 'two.txt');
  const ambiguous = skwctl(two.env, ['admin', 'bootstrap', '--enrolment-out', twoPath]);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /REFUSAL: AMBIGUOUS_TARGET/);
  assert.equal(existsSync(twoPath), false);
  // …and --tenant resolves it.
  const named = skwctl(two.env, ['admin', 'bootstrap', '--tenant', 'beta', '--enrolment-out', twoPath]);
  assert.equal(named.status, 0, named.stderr);
  const namedDb = new Database(two.controlDb, { readonly: true });
  const betaId = (namedDb.prepare("SELECT id FROM tenant WHERE key = 'beta'").get() as { id: number }).id;
  const row = namedDb.prepare('SELECT tenant_id FROM user_account').get() as { tenant_id: number };
  namedDb.close();
  assert.equal(row.tenant_id, betaId);
  empty.cleanup();
  two.cleanup();
});

test('5. a fleet_admin target with SKW_FLEET_MODE=0 refuses', () => {
  const fleet = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  const db = new Database(fleet.controlDb);
  db.prepare("INSERT INTO user_account (tenant_id, email, password_hash, role) VALUES (NULL, 'fleet@skw.test', 'x', 'fleet_admin')").run();
  db.close();
  const path = join(fleet.dir, 'fleet.txt');
  const run = skwctl({ ...fleet.env, SKW_FLEET_MODE: '0' }, [
    'admin',
    'bootstrap',
    '--email',
    'fleet@skw.test',
    '--enrolment-out',
    path,
  ]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /REFUSAL: FLEET_ADMIN_DISABLED/);
  assert.equal(existsSync(path), false);
  fleet.cleanup();
});

test('6. SKW_RENDER_MODE=snapshot refuses to write control.db', () => {
  const snapshot = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  const path = join(snapshot.dir, 'snap.txt');
  const run = skwctl({ ...snapshot.env, SKW_RENDER_MODE: 'snapshot' }, [
    'admin',
    'bootstrap',
    '--enrolment-out',
    path,
  ]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /REFUSAL: SNAPSHOT_MODE/);
  assert.equal(existsSync(path), false);
  const db = new Database(snapshot.controlDb, { readonly: true });
  assert.equal((db.prepare('SELECT count(*) AS n FROM user_account').get() as { n: number }).n, 0);
  db.close();
  snapshot.cleanup();
});

test('7. a non-TTY invocation without --enrolment-out refuses and writes nothing anywhere', () => {
  const quiet = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  const run = skwctl(quiet.env, ['admin', 'bootstrap', '--generate-password']);
  // spawnSync gives the child a pipe, which is exactly the install-log case.
  assert.equal(run.status, 1);
  assert.match(run.stderr, /REFUSAL: SECRET_NOT_PRINTABLE/);
  const db = new Database(quiet.controlDb, { readonly: true });
  assert.equal((db.prepare('SELECT count(*) AS n FROM user_account').get() as { n: number }).n, 0);
  db.close();
  const files = readdirSync(quiet.dir).filter((f) => f.endsWith('.txt'));
  assert.deepEqual(files, []);
  quiet.cleanup();
});

test('8. the file is 0600 and a second --enrolment-out to the same path refuses (O_EXCL)', () => {
  const mode = statSync(firstFile).mode & 0o777;
  assert.equal(mode.toString(8), '600', `mode is ${mode.toString(8)}`);

  const again = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  const path = join(again.dir, 'once.txt');
  const one = skwctl(again.env, ['admin', 'bootstrap', '--enrolment-out', path]);
  assert.equal(one.status, 0, one.stderr);
  const two = skwctl(again.env, ['admin', 'bootstrap', '--enrolment-out', path, '--tenant', 'acme']);
  // The row is claimed now, so the refusal is exit 3 either way; the O_EXCL path is
  // asserted directly, which is where a second *successful* write would land.
  assert.equal(two.status, 3, two.stderr);
  const forced = skwctl(again.env, ['admin', 'reset-totp', '--email', enrolmentOf(path).email, '--enrolment-out', path]);
  assert.equal(forced.status, 1, forced.stderr);
  assert.match(forced.stderr, /REFUSAL: ENROLMENT_EXISTS/);
  again.cleanup();
});

test('9. the secret is in the enrolment file and in no other artefact', () => {
  const secret = first.secret;
  const spaced = secret.replace(/(.{4})/g, '$1 ').trim();

  const fileText = readFileSync(firstFile, 'utf8');
  assert.ok(fileText.includes(spaced), 'the file carries the secret in groups of four');
  assert.ok(fileText.includes(secret), 'the file carries the URI, and the URI carries the secret');

  // The one row that must hold it, and the rest of the database that must not.
  assert.equal(userRow(fixture, 'owner@acme.test').totp_secret, secret, 'the row is where the secret lives');
  const dbText = databaseText(fixture);
  assert.equal(dbText.includes(secret), false, 'the secret must not reach audit_log or any other table');
  assert.equal(dbText.includes(first.password as string), false, 'nor the password');

  // Stdout of a fresh run, captured as a pipe (the install-log case).
  const capture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  const path = join(capture.dir, 'capture.txt');
  const run = skwctl(capture.env, ['admin', 'bootstrap', '--enrolment-out', path]);
  assert.equal(run.status, 0, run.stderr);
  const captured = enrolmentOf(path);
  assert.equal(run.stdout.includes(captured.secret), false);
  assert.equal(run.stdout.includes(captured.password as string), false);
  assert.equal(run.stderr.includes(captured.secret), false);
  // And nothing that looks like a bundle artefact was written next to it.
  assert.equal(existsSync(join(capture.dir, 'BUNDLE.json')), false);
  assert.equal(existsSync(join(capture.dir, 'control.seed.json')), false);
  capture.cleanup();
});
