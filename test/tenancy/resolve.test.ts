/**
 * §16 S1 gate as amended by 02-errata E-1: "the 10 resolution rows produce the
 * 10 documented outcomes, one test each — tenancy/resolve.test.ts, 10 cases",
 * each asserting **the row number the resolver reports**.
 *
 * **D37 supersedes rows 1 and 7 and nothing else.** Both were the admin *listener*'s
 * rows: row 1 refused a tenant header on the admin hostname, row 7 resolved the admin
 * tenant from `session.tenant_id`. Admin is `/admin` on each tenant host now, the
 * tenant is the Host's, and a session cannot choose it — so there is no listener to
 * have those rows about, and `resolveTenant` no longer takes a `listener` or a
 * `session` at all. The two tests below are rewritten to assert the NEW promise at the
 * same place the old one was asserted:
 *
 *   - row 1's replacement is the admin surface's own header refusal, asserted where
 *     it now lives (`test/admin-listener.test.ts`, which is the file that used to say
 *     "admin is 404 on every tenant host");
 *   - row 7's replacement is that `Host` is the only source, asserted here: the same
 *     request that used to resolve `beta` from a session resolves `acme` from the Host.
 *
 * The surviving rows keep their numbers. A gap in the table is honest; renumbering
 * would make every citation of "row 8" in the build reports point at a different rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildApp, type AppHandle } from '../../app/main.ts';
import { targetVersion } from '../../app/db/migrate.ts';
import { loadEnv } from '../../app/env.ts';
import { EDGE_TOKEN, REPO, makeFixture, type Fixture } from '../helpers/fixture.ts';
import { call } from '../helpers/http.ts';
import {
  resolveTenant,
  peerInCidrs,
  type ProbeResult,
  type ResolveDeps,
  type Tenant,
} from '../../app/tenancy/resolve.ts';

const TRUSTED = '127.0.0.1';
const UNTRUSTED = '203.0.113.9';
const EDGE = 'edge-token-value';

const acme: Tenant = { id: 1, key: 'acme', mode: 'production', status: 'active', dbVersion: 3 };
const beta: Tenant = { id: 2, key: 'beta', mode: 'production', status: 'active', dbVersion: 3 };
const frozen: Tenant = { id: 3, key: 'frozen', mode: 'production', status: 'suspended', dbVersion: 3 };
const stale: Tenant = { id: 4, key: 'stale', mode: 'production', status: 'active', dbVersion: 3 };
const gone: Tenant = { id: 5, key: 'gone', mode: 'production', status: 'active', dbVersion: 3 };
const busy: Tenant = { id: 6, key: 'busy', mode: 'production', status: 'active', dbVersion: 3 };

const byKey = new Map([acme, beta, frozen, stale, gone, busy].map((t) => [t.key, t]));
const byId = new Map([acme, beta, frozen, stale, gone, busy].map((t) => [t.id, t]));
const byHost = new Map<string, Tenant>([
  ['acme.test', acme],
  ['www.acme.test', acme],
  ['beta.test', beta],
  ['frozen.test', frozen],
  ['stale.test', stale],
  ['gone.test', gone],
  ['busy.test', busy],
]);

const probes: Record<string, ProbeResult> = { stale: 'stale', gone: 'unavailable', busy: 'busy' };

const deps: ResolveDeps = {
  edgeToken: EDGE,
  trustedCidrs: ['127.0.0.1/32', '172.16.0.0/12'],
  lookupHost: (h) => byHost.get(h),
  lookupKey: (k) => byKey.get(k),
  lookupId: (id) => byId.get(id),
  probe: (t) => probes[t.key] ?? 'ok',
};

function resolve(over: {
  peer?: string;
  host?: string;
  headers?: Record<string, string | string[] | undefined>;
}) {
  return resolveTenant(
    {
      peer: over.peer ?? TRUSTED,
      host: over.host ?? 'acme.test',
      headers: over.headers ?? {},
    },
    deps,
  );
}

/** Every outcome the public listener produced, for E-1 (c). */
const publicRows: number[] = [];

/*
 * D37 SUPERSEDED ROW 1. There is no admin listener, so `resolveTenant` has no row 1
 * and this file cannot assert it. The rule — a tenant header never selects the admin
 * tenant — is still enforced, one layer up and on the only surface where it means
 * something: `AdminSurface.handle` throws 421 SKW_E_PLT_EDGE_PROOF for a non-empty
 * `X-Skunkworks-Tenant` on `/admin`, and the witness is
 * `test/admin-listener.test.ts` test (c). Deleting the row without saying where its
 * gate went would be the kind of green suite this project exists not to have.
 */

test('row 2 — an untrusted peer that asserts any X-Skunkworks-* header is 421', () => {
  const r = resolve({ peer: UNTRUSTED, host: 'acme.test', headers: { 'x-skunkworks-edge': EDGE } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.step, 2);
  assert.equal(r.error.code, 'SKW_E_PLT_EDGE_PROOF');
  assert.equal(r.error.status, 421);
});

test('row 3 — a non-empty tenant header without the edge token is 421', () => {
  const r = resolve({ host: 'acme.test', headers: { 'x-skunkworks-tenant': 'beta', 'x-skunkworks-edge': 'wrong' } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.step, 3);
  assert.equal(r.error.code, 'SKW_E_PLT_EDGE_PROOF');
  assert.equal(r.error.status, 421);
});

test('row 4 — a tenant header that is not a tenant key is 400', () => {
  for (const bad of ['BETA', 'beta_1', '-beta', 'a'.repeat(64), 'beta,acme']) {
    const r = resolve({ headers: { 'x-skunkworks-tenant': bad, 'x-skunkworks-edge': EDGE } });
    assert.equal(r.ok, false, `expected refusal for ${bad}`);
    if (r.ok) continue;
    assert.equal(r.step, 4, `row for ${bad}`);
    assert.equal(r.error.code, 'SKW_E_PLT_TENANT_HEADER');
    assert.equal(r.error.status, 400);
  }
});

test('row 5 — a tenant header that disagrees with X-Forwarded-Prefix is 400', () => {
  const r = resolve({
    headers: {
      'x-skunkworks-tenant': 'beta',
      'x-skunkworks-edge': EDGE,
      'x-forwarded-prefix': '/demo/acme',
    },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.step, 5);
  assert.equal(r.error.code, 'SKW_E_PLT_TENANT_HEADER');
  assert.equal(r.error.status, 400);
});

test('row 6 — a valid header from the edge selects that tenant, prefix from the header or ""', () => {
  const withPrefix = resolve({
    host: 'acme.test',
    headers: {
      'x-skunkworks-tenant': 'beta',
      'x-skunkworks-edge': EDGE,
      'x-forwarded-prefix': '/demo/beta',
    },
  });
  assert.equal(withPrefix.ok, true);
  if (!withPrefix.ok) return;
  assert.equal(withPrefix.step, 6);
  assert.equal(withPrefix.tenant.key, 'beta');
  assert.equal(withPrefix.via, 'header');
  assert.equal(withPrefix.prefix, '/demo/beta');

  // E-11: no prefix header means "", never null and never a client value.
  const noPrefix = resolve({ host: 'acme.test', headers: { 'x-skunkworks-tenant': 'beta', 'x-skunkworks-edge': EDGE } });
  assert.equal(noPrefix.ok, true);
  if (!noPrefix.ok) return;
  assert.equal(noPrefix.step, 6);
  assert.equal(noPrefix.prefix, '');

  // A well-formed header naming a tenant that does not exist is a 404 at row 6:
  // the table gives row 6 no miss row, and TENANT_UNKNOWN is the only code the
  // taxonomy has for it (recorded in docs/build/S1-report.md §8).
  const miss = resolve({ host: 'acme.test', headers: { 'x-skunkworks-tenant': 'nope', 'x-skunkworks-edge': EDGE } });
  assert.equal(miss.ok, false);
  if (miss.ok) return;
  assert.equal(miss.step, 6);
  assert.equal(miss.error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
});

/*
 * D37 SUPERSEDED ROW 7: `session.tenant_id` no longer selects a tenant, on any row.
 * The property the row encoded — "an admin request's tenant is decided by the server,
 * not by the caller" — is now `Host`-decided, and it is asserted here as the negative:
 * there is no input left with which to ask for another tenant.
 */
test('D37 (was row 7) — the Host is the only source: no input can name another tenant', () => {
  const r = resolve({ host: 'acme.test', headers: {} });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.step, 8, 'the plain host row, not a session row');
  assert.equal(r.tenant.key, 'acme');
  assert.equal(r.via, 'host');

  // A session id cannot be passed at all: the input type has no such field, and at
  // runtime an extra property is ignored by the resolver.
  const withJunk = resolveTenant(
    { peer: TRUSTED, host: 'acme.test', headers: {}, session: { tenantId: 2 } } as never,
    deps,
  );
  assert.equal(withJunk.ok, true);
  if (!withJunk.ok) return;
  assert.equal(withJunk.tenant.key, 'acme', 'a session-shaped field on the input changes nothing');
  assert.equal(withJunk.via, 'host');
});

test('row 8 — no header on the public listener resolves from the normalised Host', () => {
  const r = resolve({ host: 'WWW.ACME.TEST:8080', headers: {} });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.step, 8);
  assert.equal(r.tenant.key, 'acme');
  assert.equal(r.via, 'host');
  assert.equal(r.host, 'www.acme.test');
  assert.equal(r.prefix, '', 'via=host never carries a prefix');

  const miss = resolve({ host: 'nobody.test', headers: {} });
  assert.equal(miss.ok, false);
  if (miss.ok) return;
  assert.equal(miss.step, 8);
  assert.equal(miss.error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(miss.error.status, 404);
});

test('row 9 — a resolved tenant that is suspended or archived is 404', () => {
  const r = resolve({ host: 'frozen.test', headers: {} });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.step, 9);
  assert.equal(r.error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(r.error.status, 404);
});

test('row 10 — a resolved tenant whose database is unusable is 503, one code per cause', () => {
  const staleRes = resolve({ host: 'stale.test' });
  assert.equal(staleRes.ok, false);
  if (staleRes.ok) return;
  assert.equal(staleRes.step, 10);
  assert.equal(staleRes.error.code, 'SKW_E_DM_SCHEMA_STALE');
  assert.equal(staleRes.error.status, 503);
  assert.equal(staleRes.error.retryAfter, 5);

  const goneRes = resolve({ host: 'gone.test' });
  assert.equal(goneRes.ok, false);
  if (goneRes.ok) return;
  assert.equal(goneRes.step, 10);
  assert.equal(goneRes.error.code, 'SKW_E_PLT_TENANT_UNAVAILABLE');
  assert.equal(goneRes.error.status, 503);
  assert.equal(goneRes.error.retryAfter, 5, 'the JSON retry_after map is the authority (§4.3)');

  const busyRes = resolve({ host: 'busy.test' });
  assert.equal(busyRes.ok, false);
  if (busyRes.ok) return;
  assert.equal(busyRes.step, 10);
  assert.equal(busyRes.error.code, 'SKW_E_DM_BUSY');
  assert.equal(busyRes.error.retryAfter, 1);
});

/* ------------------------------------------------------------------ */
/* E-1 (a): an empty tenant header over a direct connection to the     */
/* admin host is row 1. The same request through the real edge is row   */
/* 7, because nginx omits an empty proxy_set_header value — that case  */
/* is test/nginx-e2e.test.ts, and it is the one that distinguishes the */
/* two.                                                                */
/* ------------------------------------------------------------------ */
/*
 * D37 SUPERSEDED E-1 (a). The case it described — an empty `X-Skunkworks-Tenant`
 * arriving at the admin host directly — cannot arise: there is no admin host. The
 * question it settled (does an empty tenant header from the edge select a tenant?)
 * is still a real one on a tenant host, and the answer is now the *opposite* of a
 * 421: the edge's own `proxy_set_header … ""` is a no-op, and the Host decides. The
 * witness is the same test in `test/admin-listener.test.ts` and the header case in
 * `test/tenancy/resolve.test.ts` below ("a client-supplied header is inert").
 */
/* ------------------------------------------------------------------ */
/* E-1 (c): no request with listener='public' may report row 1 or 7.   */
/* ------------------------------------------------------------------ */
test("E-1 (c) — no request reports row 1 or row 7, because neither row exists (D37)", () => {
  const cases: Array<Parameters<typeof resolve>[0]> = [
    { host: 'acme.test', headers: {} },
    { host: 'www.acme.test', headers: {} },
    { host: 'nobody.test', headers: {} },
    { host: 'frozen.test', headers: {} },
    { host: 'stale.test', headers: {} },
    { host: 'acme.test', headers: { 'x-skunkworks-tenant': 'beta', 'x-skunkworks-edge': EDGE } },
    { host: 'acme.test', headers: { 'x-skunkworks-tenant': '', 'x-skunkworks-edge': EDGE } },
    { host: 'acme.test', headers: { 'x-skunkworks-tenant': 'BETA', 'x-skunkworks-edge': EDGE } },
    { host: 'acme.test', headers: { 'x-skunkworks-tenant': 'beta', 'x-skunkworks-edge': 'wrong' } },
    { peer: UNTRUSTED, host: 'acme.test', headers: { 'x-skunkworks-tenant': 'beta' } },
  ];
  const rows = cases.map((c) => {
    const r = resolve(c);
    return r.step;
  });
  for (const row of rows) {
    assert.notEqual(row, 1, `a request reported row 1, which D37 removed: ${rows.join(',')}`);
    assert.notEqual(row, 7, `a request reported row 7, which D37 removed: ${rows.join(',')}`);
  }
  publicRows.push(...rows);
  assert.ok(publicRows.length > 0);
});

/* ------------------------------------------------------------------ */
/* §16 S1: "a client-supplied X-Skunkworks-Tenant is inert on a         */
/* host-routed location — same suite, cases 1-5". Every case below has a */
/* Host that maps to acme and a header that claims beta; none of them    */
/* may resolve to beta, and none may resolve via header.                 */
/* ------------------------------------------------------------------ */
test('inert 1 — a client header with no edge token is refused, not honoured', () => {
  const r = resolve({ host: 'acme.test', headers: { 'x-skunkworks-tenant': 'beta' } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.code, 'SKW_E_PLT_EDGE_PROOF');
});

test('inert 2 — a client header with a guessed edge token is refused, not honoured', () => {
  const r = resolve({ host: 'acme.test', headers: { 'x-skunkworks-tenant': 'beta', 'x-skunkworks-edge': 'guess' } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.step, 3);
  assert.equal(r.error.code, 'SKW_E_PLT_EDGE_PROOF');
});

test('inert 3 — an empty header is no assertion: the Host decides', () => {
  const r = resolve({ host: 'acme.test', headers: { 'x-skunkworks-tenant': '' } });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.tenant.key, 'acme');
  assert.equal(r.via, 'host');
  assert.equal(r.step, 8);
});

test('inert 4 — a malformed claim is a 400, never a silent fallback', () => {
  const r = resolve({
    host: 'acme.test',
    headers: { 'x-skunkworks-tenant': 'beta/../acme', 'x-skunkworks-edge': EDGE },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.code, 'SKW_E_PLT_TENANT_HEADER');
});

test('inert 5 — a valid claim with a valid token still cannot cross a prefix mismatch', () => {
  const r = resolve({
    host: 'acme.test',
    headers: { 'x-skunkworks-tenant': 'beta', 'x-skunkworks-edge': EDGE, 'x-forwarded-prefix': '/demo/acme' },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.code, 'SKW_E_PLT_TENANT_HEADER');
});

test('CIDR containment: the two frozen defaults and the loopback forms', () => {
  assert.equal(peerInCidrs('127.0.0.1', ['127.0.0.1/32']), true);
  assert.equal(peerInCidrs('::1', ['127.0.0.1/32']), true);
  assert.equal(peerInCidrs('::ffff:127.0.0.1', ['127.0.0.1/32']), true);
  assert.equal(peerInCidrs('172.18.0.5', ['127.0.0.1/32', '172.16.0.0/12']), true);
  assert.equal(peerInCidrs('203.0.113.9', ['127.0.0.1/32', '172.16.0.0/12']), false);
  assert.equal(peerInCidrs('172.32.0.1', ['172.16.0.0/12']), false);
  assert.equal(peerInCidrs('not-an-ip', ['0.0.0.0/0']), false);
});

/* ------------------------------------------------------------------ */
/* E-7 — every Retry-After in the taxonomy is asserted on the wire.    */
/* The unit assertion on `err.retryAfter` is not the gate: the header  */
/* is the contract, and it is the only part a proxy or client acts on. */
/* ------------------------------------------------------------------ */
interface RetryApp {
  handle: AppHandle;
  fixture: Fixture;
  port: number;
  locker: Database.Database;
  close(): Promise<void>;
}

async function bootRetryApp(): Promise<RetryApp> {
  const fixture = makeFixture({
    specs: [
      { key: 'acme', hosts: ['acme.test'] },
      { key: 'stale', hosts: ['stale.test'] },
      { key: 'busy', hosts: ['busy.test'] },
      { key: 'broken', hosts: ['broken.test'], corrupt: true },
    ],
  });
  const handle = await buildApp({ env: loadEnv({ ...fixture.env, SKW_DB_BUSY_TIMEOUT_MS: '50' }) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // row 10, `user_version < tenant.db_version` — one past the shipped target, read from the DDL
  // rather than typed, so shipping a new schema version cannot quietly make this row unreachable.
  const control = new Database(fixture.controlDb);
  control
    .prepare("UPDATE tenant SET db_version = ? WHERE key = 'stale'")
    .run(targetVersion(join(REPO, 'schema', 'site.sql')) + 1);
  control.close();

  // row 10, `SQLITE_BUSY` after busy_timeout: a rollback-journal file with an
  // exclusive lock held by a second connection. WAL readers do not block, so the
  // journal mode is part of the fixture.
  const prep = new Database(fixture.sitePath('busy'));
  prep.pragma('journal_mode = DELETE');
  prep.close();
  const locker = new Database(fixture.sitePath('busy'));
  locker.pragma('busy_timeout = 10');
  locker.exec('BEGIN EXCLUSIVE');
  locker.prepare('UPDATE cms_page SET title = title').run();

  return {
    handle,
    fixture,
    port,
    locker,
    async close() {
      locker.exec('ROLLBACK');
      locker.close();
      await handle.close();
      fixture.cleanup();
    },
  };
}

test('E-7 — every code with a retry_after entry carries the header, with that value', async () => {
  const codes = JSON.parse(readFileSync(join(REPO, 'schema', 'error-codes.json'), 'utf8')) as {
    retry_after: Record<string, number>;
  };
  const app = await bootRetryApp();
  // One reachable request per entry in the frozen map. The map has three entries,
  // and the assertion is that the JSON's number is what arrives on the wire.
  const hosts: Record<string, string> = {
    SKW_E_DM_SCHEMA_STALE: 'stale.test',
    SKW_E_DM_BUSY: 'busy.test',
    SKW_E_PLT_TENANT_UNAVAILABLE: 'broken.test',
  };
  try {
    assert.deepEqual(Object.keys(codes.retry_after).sort(), Object.keys(hosts).sort(), 'the frozen retry_after map changed');
    for (const [code, seconds] of Object.entries(codes.retry_after)) {
      const res = await call({ port: app.port, path: '/pricing', host: hosts[code] as string });
      assert.equal(res.status, 503, `${code} status`);
      assert.equal((res.json as { error: { code: string } }).error.code, code);
      assert.equal(res.headers['retry-after'], String(seconds), `${code} retry-after on the wire`);
      assert.match(String(res.headers['retry-after']), /^\d+$/, 'delta-seconds, never an HTTP-date');
    }
  } finally {
    await app.close();
  }
});

test('E-7 — no other code carries the header', async () => {
  const app = await bootRetryApp();
  try {
    const cases: { name: string; res: Awaited<ReturnType<typeof call>> }[] = [];
    cases.push({
      name: 'SKW_E_PLT_EDGE_PROOF 421',
      res: await call({ port: app.port, path: '/pricing', host: 'acme.test', headers: { 'x-skunkworks-tenant': 'acme' } }),
    });
    cases.push({
      name: 'SKW_E_PLT_TENANT_HEADER 400',
      res: await call({
        port: app.port,
        path: '/pricing',
        host: 'acme.test',
        headers: { 'x-skunkworks-tenant': 'BETA', 'x-skunkworks-edge': EDGE_TOKEN },
      }),
    });
    cases.push({ name: 'SKW_E_PLT_TENANT_UNKNOWN 404', res: await call({ port: app.port, path: '/pricing', host: 'nobody.test' }) });
    cases.push({ name: 'SKW_E_RT_PAGE_NOT_FOUND 404', res: await call({ port: app.port, path: '/no-such-page', host: 'acme.test' }) });
    for (const { name, res } of cases) {
      assert.equal(res.headers['retry-after'], undefined, `${name} must not carry Retry-After`);
    }
  } finally {
    await app.close();
  }
});
