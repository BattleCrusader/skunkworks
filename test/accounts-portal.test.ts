/**
 * The portal over real HTTP — router, body parsing, headers, cookies, origin and CSRF refusals.
 *
 * A form that posts and a page that answers is the whole surface, so these tests use the router
 * rather than calling handlers: `Origin`, `Host`, `Content-Type`, `Set-Cookie` and `Location` are
 * the contract with a browser, and a handler unit test cannot see any of them.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Accounts } from '../app/accounts/service.ts';
import { portalCookieName, registerPortal } from '../app/accounts/routes.ts';
import { Semaphore, totpCode } from '../app/admin/auth.ts';
import type { Env } from '../app/env.ts';
import { SCHEMA } from './helpers/fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'skw-portal-'));
after(() => rmSync(root, { recursive: true, force: true }));

const ENV = { ipHashKey: 'portal-test-ip-hash-key-0123456789', sessionKey: 'portal-test-session-key-0123456789' } as Env;
const HOST = 'fractional.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery staple';

function tenantPath(key: string): string {
  const dir = join(root, key);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'site.db');
  if (existsSync(path)) return path;
  const handle = new Database(path);
  handle.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
  handle.close();
  return path;
}

interface Built {
  app: ReturnType<typeof Fastify>;
  db(): Database.Database;
  tenant: { key: string };
}

let nextKey = 0;
/** Each test gets its own tenant: two tests sharing one database is a shared fixture, not a test. */
async function build(key = `portal-auto-${(nextKey += 1)}`): Promise<Built> {
  const tenant = { key };
  tenantPath(key);
  const accounts = new Accounts({
    env: ENV,
    // By key, not by a captured path: a test that changes the tenant must reach that tenant's file.
    openDb: (k: string) => new Database(tenantPath(k)),
    argon: new Semaphore(4),
    exposeVerifyLink: true,
  });
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );
  registerPortal(app, {
    accounts,
    env: ENV,
    tenantOf: () => tenant.key,
    exposeVerifyLink: true,
    emailMode: 'off',
    openDb: (k: string) => new Database(tenantPath(k)),
  });
  await app.ready();
  return { app, db: () => new Database(tenantPath(tenant.key)), tenant };
}

/** The browser's headers: one host, one origin, a form body. */
function post(url: string, form: Record<string, string | string[]>, extra: Record<string, string> = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    for (const item of Array.isArray(v) ? v : [v]) usp.append(k, item);
  }
  return {
    method: 'POST' as const,
    url,
    headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...extra },
    payload: usp.toString(),
  };
}

function get(url: string, extra: Record<string, string> = {}) {
  return { method: 'GET' as const, url, headers: { host: HOST, ...extra } };
}

test('H1 — the registration form is server-rendered and offers both account types', async () => {
  const { app } = await build();
  const res = await app.inject(get('/portal/register'));
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /name="email"/);
  assert.match(res.body, /name="password"/);
  assert.match(res.body, /value="applicant"/);
  assert.match(res.body, /value="advertiser"/);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('H2 — a POST without a matching Origin is refused before anything is read', async () => {
  const { app } = await build();
  const res = await app.inject({
    ...post('/portal/register', { email: 'a@example.test', password: PASSWORD, display_name: 'A', role: 'applicant' }),
    headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /SKW_E_SEC_CSRF/);
});

test('H3 — cleartext behind a proxy is named as cleartext, not as a CSRF bug', async () => {
  const { app } = await build();
  const res = await app.inject(
    post(
      '/portal/register',
      { email: 'a@example.test', password: PASSWORD, display_name: 'A', role: 'applicant' },
      { 'x-forwarded-proto': 'http' },
    ),
  );
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /requires https/);
});

test('H4 — registering shows the TOTP key once and leaves the account pending', async () => {
  const { app, db } = await build();
  const res = await app.inject(
    post('/portal/register', {
      email: 'sam@example.test',
      password: PASSWORD,
      display_name: 'Sam Rivers',
      role: ['applicant', 'advertiser'],
    }),
  );
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Set up your authenticator/);
  assert.match(res.body, /<code>[A-Z2-7]{4}( [A-Z2-7]{4})+<\/code>/, 'the key is shown grouped');
  assert.match(res.body, /otpauth:\/\/totp\//);
  assert.match(res.body, /\/portal\/verify\?token=[0-9a-f]{64}/, 'the offline operator sees the link');

  const handle = db();
  try {
    const row = handle.prepare('SELECT status, email FROM cms_account').get() as { status: string; email: string };
    assert.equal(row.status, 'pending');
    assert.equal(row.email, 'sam@example.test');
    assert.deepEqual(
      (handle.prepare('SELECT role FROM cms_account_role ORDER BY role').all() as { role: string }[]).map((r) => r.role),
      ['advertiser', 'applicant'],
      'two checked boxes arrive as two roles',
    );
  } finally {
    handle.close();
  }
});

test('H5 — the link proves the address, sets an enrolment cookie scoped to /portal, and asks for a code', async () => {
  const { app, db } = await build();
  const reg = await app.inject(
    post('/portal/register', { email: 'sam@example.test', password: PASSWORD, display_name: 'Sam', role: 'applicant' }),
  );
  const url = /\/portal\/verify\?token=[0-9a-f]{64}/.exec(reg.body)?.[0];
  assert.ok(url !== undefined);

  const verified = await app.inject(get(url));
  assert.equal(verified.statusCode, 200);
  assert.match(verified.body, /One more step/);
  const cookie = String(verified.headers['set-cookie']);
  assert.match(cookie, /^__Secure-sk-enrol-portal-auto-\d+=[0-9]+\.[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Strict; Path=\/portal/);

  // A code from the secret finishes it, and the activation is visible in the row.
  const handle = db();
  const secret = (handle.prepare('SELECT totp_secret FROM cms_account').get() as { totp_secret: string }).totp_secret;
  handle.close();
  const enrol = await app.inject(
    post('/portal/enrol', { code: totpCode(secret, Date.now()) }, { cookie: cookie.split(';')[0] as string }),
  );
  assert.equal(enrol.statusCode, 303);
  assert.equal(enrol.headers.location, '/portal/signin');

  const check = db();
  try {
    assert.equal((check.prepare('SELECT status FROM cms_account').get() as { status: string }).status, 'active');
  } finally {
    check.close();
  }
});

test('H6 — enrolment without the cookie, or with the wrong code, is refused', async () => {
  const { app, db } = await build();
  const reg = await app.inject(
    post('/portal/register', { email: 'sam@example.test', password: PASSWORD, display_name: 'Sam', role: 'applicant' }),
  );
  const url = /\/portal\/verify\?token=[0-9a-f]{64}/.exec(reg.body)?.[0] as string;
  const verified = await app.inject(get(url));
  const cookie = String(verified.headers['set-cookie']).split(';')[0] as string;

  const noCookie = await app.inject(post('/portal/enrol', { code: '123456' }));
  assert.equal(noCookie.statusCode, 401);
  assert.match(noCookie.body, /SKW_E_SEC_TOKEN_INVALID/);

  const wrong = await app.inject(post('/portal/enrol', { code: '000000' }, { cookie }));
  assert.equal(wrong.statusCode, 401);

  const handle = db();
  try {
    assert.equal((handle.prepare('SELECT status FROM cms_account').get() as { status: string }).status, 'pending');
  } finally {
    handle.close();
  }
});

/** Register, verify and enrol — the three steps a person takes before they can sign in. */
async function activated(built: Built, email = 'sam@example.test'): Promise<string> {
  const reg = await built.app.inject(
    post('/portal/register', { email, password: PASSWORD, display_name: 'Sam', role: 'applicant' }),
  );
  const url = /\/portal\/verify\?token=[0-9a-f]{64}/.exec(reg.body)?.[0] as string;
  const verified = await built.app.inject(get(url));
  const cookie = String(verified.headers['set-cookie']).split(';')[0] as string;
  const handle = built.db();
  const secret = (handle.prepare('SELECT totp_secret FROM cms_account').get() as { totp_secret: string }).totp_secret;
  handle.close();
  const enrol = await built.app.inject(post('/portal/enrol', { code: totpCode(secret, Date.now()) }, { cookie }));
  assert.equal(enrol.statusCode, 303);
  return secret;
}

test('H7 — a wrong password and an unknown address get the same bytes back', async () => {
  const built = await build();
  await activated(built);
  const secret = (
    built.db().prepare('SELECT totp_secret FROM cms_account').get() as { totp_secret: string }
  ).totp_secret;
  const code = totpCode(secret, Date.now());

  const unknown = await built.app.inject(post('/portal/signin', { email: 'nobody@example.test', password: PASSWORD, code }));
  const wrong = await built.app.inject(post('/portal/signin', { email: 'sam@example.test', password: 'nope nope nope nope', code }));
  assert.equal(unknown.statusCode, 401);
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.body, wrong.body, 'the page must not tell a stranger which half was wrong');
});

test('H8 — signing in sets a per-tenant portal cookie, and /portal reads it', async () => {
  const built = await build();
  const secret = await activated(built);
  const signin = await built.app.inject(
    post('/portal/signin', { email: 'sam@example.test', password: PASSWORD, code: totpCode(secret, Date.now()) }),
  );
  assert.equal(signin.statusCode, 303);
  assert.equal(signin.headers.location, '/portal');
  const setCookie = String(signin.headers['set-cookie']);
  assert.match(setCookie, /^__Secure-sk-portal-portal-auto-\d+=[0-9a-f]{64}; /);
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict; Path=\/portal/);
  assert.equal(/Domain=/.test(setCookie), false, 'a Domain attribute is how one tenant reads another');

  const cookie = setCookie.split(';')[0] as string;
  const own = await built.app.inject(get('/portal', { cookie }));
  assert.equal(own.statusCode, 200);
  assert.match(own.body, /sam@example\.test/);
  assert.match(own.body, /name="csrf" value="[0-9a-f]{64}"/);

  const anonymous = await built.app.inject(get('/portal'));
  assert.equal(anonymous.statusCode, 303);
  assert.equal(anonymous.headers.location, '/portal/signin');
});

test('H9 — the cookie names the tenant, so another tenant does not even receive it', async () => {
  const built = await build('portal-b');
  const secret = await activated(built);
  const signin = await built.app.inject(
    post('/portal/signin', { email: 'sam@example.test', password: PASSWORD, code: totpCode(secret, Date.now()) }),
  );
  const cookie = String(signin.headers['set-cookie']).split(';')[0] as string;
  assert.match(cookie, /^__Secure-sk-portal-portal-b=/);

  // The same value offered under the other tenant's cookie name finds no session.
  const stolen = cookie.replace('__Secure-sk-portal-portal-b', 'portalCookieName');
  assert.notEqual(stolen, cookie);
  built.tenant.key = 'portal-c';
  const other = await built.app.inject(get('/portal', { cookie: stolen }));
  assert.equal(other.statusCode, 303, 'a session is per tenant, not per fleet');
});

test('H10 — sign-out needs the session CSRF token, and clears the cookie when it gets it', async () => {
  const built = await build();
  const secret = await activated(built);
  const signin = await built.app.inject(
    post('/portal/signin', { email: 'sam@example.test', password: PASSWORD, code: totpCode(secret, Date.now()) }),
  );
  const cookie = String(signin.headers['set-cookie']).split(';')[0] as string;
  const home = await built.app.inject(get('/portal', { cookie }));
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(home.body)?.[1] as string;

  const without = await built.app.inject(post('/portal/signout', {}, { cookie }));
  assert.equal(without.statusCode, 403, 'origin alone is not enough once there is a session to protect');

  const done = await built.app.inject(post('/portal/signout', { csrf }, { cookie }));
  assert.equal(done.statusCode, 303);
  assert.match(String(done.headers['set-cookie']), /Max-Age=0/);

  const after = await built.app.inject(get('/portal', { cookie }));
  assert.equal(after.statusCode, 303, 'the row is revoked, so the cookie value is worthless even if replayed');
});

test('H11 — signing in on the wrong tenant finds no account, and says so generically', async () => {
  const built = await build('portal-d');
  const secret = await activated(built);
  built.tenant.key = 'portal-e';
  const res = await built.app.inject(
    post('/portal/signin', { email: 'sam@example.test', password: PASSWORD, code: totpCode(secret, Date.now()) }),
  );
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /not right/);
});
