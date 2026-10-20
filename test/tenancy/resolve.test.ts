/**
 * §16 S1 gate: "the 10 resolution steps produce the 10 documented outcomes, one
 * test each — tenancy/resolve.test.ts, 10 cases" and "a client-supplied
 * X-Skunkworks-Tenant is inert on a host-routed location — same suite, cases 1-5".
 *
 * One `test()` per step, in step order, asserting the step number the resolver
 * reports as well as the outcome. A wrong step is a defect even when the status
 * matches, because the order is the contract (§5.3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
  listener?: 'public' | 'admin';
  session?: { tenantId: number } | null;
}) {
  return resolveTenant(
    {
      peer: over.peer ?? TRUSTED,
      host: over.host ?? 'acme.test',
      headers: over.headers ?? {},
      listener: over.listener ?? 'public',
      session: over.session ?? null,
    },
    deps,
  );
}

test('step 1 — an untrusted peer that asserts any X-Skunkworks-* header is 421', () => {
  const r = resolve({ peer: UNTRUSTED, host: 'acme.test', headers: { 'x-skunkworks-edge': EDGE } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.step, 1);
  assert.equal(r.error.code, 'SKW_E_PLT_EDGE_PROOF');
  assert.equal(r.error.status, 421);
});

test('step 2 — a non-empty tenant header without the edge token is 421', () => {
  const r = resolve({ host: 'acme.test', headers: { 'x-skunkworks-tenant': 'beta', 'x-skunkworks-edge': 'wrong' } });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.step, 2);
  assert.equal(r.error.code, 'SKW_E_PLT_EDGE_PROOF');
  assert.equal(r.error.status, 421);
});

test('step 3 — a tenant header that is not a tenant key is 400', () => {
  for (const bad of ['BETA', 'beta_1', '-beta', 'a'.repeat(64), 'beta,acme']) {
    const r = resolve({ headers: { 'x-skunkworks-tenant': bad, 'x-skunkworks-edge': EDGE } });
    assert.equal(r.ok, false, `expected refusal for ${bad}`);
    if (r.ok) continue;
    assert.equal(r.step, 3, `step for ${bad}`);
    assert.equal(r.error.code, 'SKW_E_PLT_TENANT_HEADER');
    assert.equal(r.error.status, 400);
  }
});

test('step 4 — a tenant header that disagrees with X-Forwarded-Prefix is 400', () => {
  const r = resolve({
    headers: {
      'x-skunkworks-tenant': 'beta',
      'x-skunkworks-edge': EDGE,
      'x-forwarded-prefix': '/demo/acme',
    },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.step, 4);
  assert.equal(r.error.code, 'SKW_E_PLT_TENANT_HEADER');
  assert.equal(r.error.status, 400);
});

test('step 5 — a valid header from the edge selects that tenant (via header)', () => {
  const r = resolve({
    host: 'acme.test',
    headers: {
      'x-skunkworks-tenant': 'beta',
      'x-skunkworks-edge': EDGE,
      'x-forwarded-prefix': '/demo/beta',
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.step, 5);
  assert.equal(r.tenant.key, 'beta');
  assert.equal(r.via, 'header');
  assert.equal(r.prefix, '/demo/beta');
});

test('step 6 — no header on the public listener resolves from the normalised Host', () => {
  const r = resolve({ host: 'WWW.ACME.TEST:8080', headers: {} });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.step, 6);
  assert.equal(r.tenant.key, 'acme');
  assert.equal(r.via, 'host');
  assert.equal(r.host, 'www.acme.test');
});

test('step 7 — no header on the admin listener resolves from session.tenant_id only', () => {
  const r = resolve({ listener: 'admin', host: 'acme.test', headers: {}, session: { tenantId: 2 } });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.step, 7);
  assert.equal(r.tenant.key, 'beta', 'the admin listener ignores Host');
  assert.equal(r.via, 'session');
});

test('step 8 — the admin listener refuses a tenant header that is present at all', () => {
  const withHeader = resolve({
    listener: 'admin',
    host: 'acme.test',
    headers: { 'x-skunkworks-tenant': 'acme', 'x-skunkworks-edge': EDGE },
    session: { tenantId: 1 },
  });
  assert.equal(withHeader.ok, false);
  if (withHeader.ok) return;
  assert.equal(withHeader.step, 8);
  assert.equal(withHeader.error.code, 'SKW_E_PLT_EDGE_PROOF');
  assert.equal(withHeader.error.status, 421);

  // "present at all" includes the empty string (§9.2, §5.3 step 8).
  const emptyHeader = resolve({
    listener: 'admin',
    host: 'acme.test',
    headers: { 'x-skunkworks-tenant': '' },
    session: { tenantId: 1 },
  });
  assert.equal(emptyHeader.ok, false);
  if (emptyHeader.ok) return;
  assert.equal(emptyHeader.step, 8);
});

test('step 9 — a resolved tenant that is suspended or archived is 404', () => {
  const r = resolve({ host: 'frozen.test', headers: {} });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.step, 9);
  assert.equal(r.error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(r.error.status, 404);
});

test('step 10 — a resolved tenant whose database is unusable is 503, one code per cause', () => {
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

  const busyRes = resolve({ host: 'busy.test' });
  assert.equal(busyRes.ok, false);
  if (busyRes.ok) return;
  assert.equal(busyRes.step, 10);
  assert.equal(busyRes.error.code, 'SKW_E_DM_BUSY');
  assert.equal(busyRes.error.retryAfter, 1);
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
  assert.equal(r.step, 2);
  assert.equal(r.error.code, 'SKW_E_PLT_EDGE_PROOF');
});

test('inert 3 — an empty header is no assertion: the Host decides', () => {
  const r = resolve({ host: 'acme.test', headers: { 'x-skunkworks-tenant': '' } });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.tenant.key, 'acme');
  assert.equal(r.via, 'host');
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
