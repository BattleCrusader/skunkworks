/**
 * §16 S2's CSRF criteria, the 12-case matrix:
 *
 *   | every non-GET without a valid CSRF token is `403 SKW_E_SEC_CSRF` | 12-case suite |
 *   | `Origin` mismatch on a non-GET is `403`                          | same |
 *
 * The route under test is a real one (`POST /admin/t/acme/session/rotate`, the
 * privilege-change rotation of §9.1), not a synthetic endpoint. Case 12 is the
 * positive control that proves the other eleven fail for the reason claimed: if
 * the token were ignored, case 12 would be 200 and so would cases 4 and 5.
 *
 * Also asserted: the rule is not one route's accident. Every non-GET the surface
 * exposes is swept without a token — `rotate`, `logout`, and `login`, whose only
 * CSRF control is the `Origin` check because it runs before a session exists.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

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
} from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const OWNER = 'csrf@acme.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

function rotate(portToUse: number, cookie: string | undefined, headers: Record<string, string>): Promise<Res> {
  const all: Record<string, string> = { 'content-type': 'application/json', ...headers };
  if (cookie !== undefined) all.cookie = cookie;
  return call({
    port: portToUse,
    path: '/admin/t/acme/session/rotate',
    method: 'POST',
    host: ADMIN_HOST,
    headers: all,
    // A real rotate carries a body; an empty JSON body would be a 400 from the
    // parser before the CSRF check, which is not what this matrix measures.
    body: '{}',
  });
}

before(async () => {
  fixture = makeFixture();
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: OWNER, totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

interface Case {
  name: string;
  headers: Record<string, string>;
  status: number;
  code?: string;
}

/** The 12 cases of §16 S2. Case 12 is the positive control. */
const CASES: Case[] = [
  { name: '1 no CSRF header', headers: { origin: ADMIN_ORIGIN }, status: 403, code: 'SKW_E_SEC_CSRF' },
  { name: '2 no CSRF header, no Origin', headers: {}, status: 403, code: 'SKW_E_SEC_CSRF' },
  {
    name: '3 empty CSRF header',
    headers: { origin: ADMIN_ORIGIN, 'x-csrf-token': '' },
    status: 403,
    code: 'SKW_E_SEC_CSRF',
  },
  {
    name: '4 43 random characters',
    headers: { origin: ADMIN_ORIGIN, 'x-csrf-token': 'A'.repeat(43) },
    status: 403,
    code: 'SKW_E_SEC_CSRF',
  },
  {
    name: '5 a valid token from another session',
    headers: { origin: ADMIN_ORIGIN, 'x-csrf-token': '<other>' },
    status: 403,
    code: 'SKW_E_SEC_CSRF',
  },
  {
    name: '6 the session id used as the token',
    headers: { origin: ADMIN_ORIGIN, 'x-csrf-token': '<id>' },
    status: 403,
    code: 'SKW_E_SEC_CSRF',
  },
  {
    name: '7 correct token, one character flipped',
    headers: { origin: ADMIN_ORIGIN, 'x-csrf-token': '<flipped>' },
    status: 403,
    code: 'SKW_E_SEC_CSRF',
  },
  { name: '8 correct token, no Origin', headers: { 'x-csrf-token': '<good>' }, status: 403, code: 'SKW_E_SEC_CSRF' },
  {
    name: '9 correct token, foreign Origin',
    headers: { origin: 'https://evil.test', 'x-csrf-token': '<good>' },
    status: 403,
    code: 'SKW_E_SEC_CSRF',
  },
  {
    name: '10 correct token, Origin with a suffix',
    headers: { origin: 'https://admin.skw.test.evil.test', 'x-csrf-token': '<good>' },
    status: 403,
    code: 'SKW_E_SEC_CSRF',
  },
  {
    name: '11 correct token, wrong scheme',
    headers: { origin: 'http://admin.skw.test', 'x-csrf-token': '<good>' },
    status: 403,
    code: 'SKW_E_SEC_CSRF',
  },
  { name: '12 correct token, exact Origin (positive control)', headers: { origin: ADMIN_ORIGIN, 'x-csrf-token': '<good>' }, status: 200 },
];

for (const testCase of CASES) {
  test(`matrix ${testCase.name}`, async () => {
    // One session per case: a case that succeeds (or a mutation that lets it
    // through) must not be able to invalidate the cookie the next case uses, or a
    // single red would cascade and hide which rule actually failed.
    const own = await openSession({ port, key: 'acme', email: OWNER });
    const id = own.cookie.slice('__Host-sk-sess='.length).split('.')[0] as string;
    const flipped = `${own.csrfToken.slice(0, -1)}${own.csrfToken.endsWith('A') ? 'B' : 'A'}`;
    const decoy = testCase.name.includes('another session')
      ? await openSession({ port, key: 'acme', email: OWNER })
      : null;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(testCase.headers)) {
      headers[k] =
        v === '<good>'
          ? own.csrfToken
          : v === '<other>'
            ? (decoy?.csrfToken ?? '')
            : v === '<id>'
              ? id
              : v === '<flipped>'
                ? flipped
                : v;
    }
    const res = await rotate(port, own.cookie, headers);
    assert.equal(res.status, testCase.status, `${testCase.name}: ${res.body}`);
    if (testCase.code !== undefined) assert.equal(codeOf(res), testCase.code, testCase.name);
  });
}

test('the matrix is not one route: every non-GET without a token is refused', async () => {
  // A fresh session per route, because a successful rotate or logout invalidates.
  const fresh = await openSession({ port, key: 'acme', email: OWNER });

  const logout = await call({
    port,
    path: '/admin/t/acme/logout',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { cookie: fresh.cookie, origin: ADMIN_ORIGIN },
  });
  assert.equal(logout.status, 403);
  assert.equal(codeOf(logout), 'SKW_E_SEC_CSRF');

  const rotateNoToken = await rotate(port, fresh.cookie, { origin: ADMIN_ORIGIN });
  assert.equal(rotateNoToken.status, 403);
  assert.equal(codeOf(rotateNoToken), 'SKW_E_SEC_CSRF');

  // Login runs before a session exists, so the Origin check is its only CSRF
  // control — and it applies (case 12 of the matrix is the positive counterpart).
  const loginNoOrigin = await login({ port, key: 'acme', email: OWNER, totp: currentTotp(), origin: null });
  assert.equal(loginNoOrigin.status, 403);
  assert.equal(codeOf(loginNoOrigin), 'SKW_E_SEC_CSRF');

  // No route may answer a non-GET with a session it minted: a 403 sets no cookie.
  for (const res of [logout, rotateNoToken, loginNoOrigin]) {
    assert.equal(res.headers['set-cookie'], undefined);
  }
});

test('a GET needs no CSRF token, and a POST with the token succeeds and rotates', async () => {
  const fresh = await openSession({ port, key: 'acme', email: OWNER });
  const get = await call({ port, path: '/admin/t/acme/session', host: ADMIN_HOST, headers: { cookie: fresh.cookie } });
  assert.equal(get.status, 200, 'a safe method is not a CSRF target');

  const ok = await rotate(port, fresh.cookie, { origin: ADMIN_ORIGIN, 'x-csrf-token': fresh.csrfToken });
  assert.equal(ok.status, 200, ok.body);
  const next = cookiePair(ok);
  assert.ok(next !== undefined);
  assert.notEqual(next, fresh.cookie, 'rotation must mint a new id');
  const json = ok.json as { csrfToken: string; rotatedFrom: string };
  assert.notEqual(json.csrfToken, fresh.csrfToken, 'the token is bound to the session and rotates with it');
  assert.equal(json.rotatedFrom.length, 64);
});

test('the token is bound to the session: two sessions of one user do not share it', async () => {
  const a = await openSession({ port, key: 'acme', email: OWNER });
  const b = await openSession({ port, key: 'acme', email: OWNER });
  assert.notEqual(a.csrfToken, b.csrfToken);

  const cross = await rotate(port, a.cookie, { origin: ADMIN_ORIGIN, 'x-csrf-token': b.csrfToken });
  assert.equal(cross.status, 403);
  assert.equal(codeOf(cross), 'SKW_E_SEC_CSRF');
});
