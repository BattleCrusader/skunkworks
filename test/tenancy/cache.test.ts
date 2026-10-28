/**
 * §16 S1 gate as amended by 02-errata E-3: the tenant map sees a control-plane
 * write on the next request.
 *
 * Every mutation below is applied by a **second** `control.db` connection while
 * the app is serving — the case the old `MAX(control_migration.id) || count(tenant)`
 * stamp could not see. The assertions are the ones `S1-qa.md` §3.6 measured as
 * failing: a suspended tenant served, a deleted host routed, a demo flip armed
 * nothing, and a raised `db_version` did not 503.
 *
 * Also asserts §5.4a: the stamp is read exactly once per request, and two reads
 * with no write between them are equal (no rebuild).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';
import { join } from 'node:path';

import { buildApp, type AppHandle } from '../../app/main.ts';
import { loadEnv } from '../../app/env.ts';
import { TenantMap } from '../../app/tenancy/cache.ts';
import { migrateTenant, targetVersion } from '../../app/db/migrate.ts';
import { REPO, makeFixture, type Fixture, type TenantSpec } from '../helpers/fixture.ts';
import { call } from '../helpers/http.ts';

const SPECS: TenantSpec[] = [
  { key: 'acme', hosts: ['acme.test'], title: 'Acme pricing' },
  { key: 'suspendme', hosts: ['suspend.test'] },
  { key: 'archiveme', hosts: ['archive.test'] },
  { key: 'modeme', hosts: ['mode.test'] },
  { key: 'versionme', hosts: ['version.test'] },
  { key: 'deleteme', hosts: ['delete.test'] },
  { key: 'gamma', hosts: [] },
];

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let writer: Database.Database;
let map: TenantMap;

before(async () => {
  fixture = makeFixture({ specs: SPECS });
  handle = await buildApp({ env: loadEnv({ ...fixture.env, SKW_DB_BUSY_TIMEOUT_MS: '50' }) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  // The second connection: the operator's `sqlite3`, in a different process in
  // production. Nothing in the app is told a write happened.
  writer = new Database(fixture.controlDb);
  writer.pragma('busy_timeout = 2000');
  // The map the app is actually using — a second instance would prove nothing
  // about the request path (§5.4a).
  map = handle.tenants;
});

after(async () => {
  writer.close();
  await handle.close();
  fixture.cleanup();
});

async function get(host: string) {
  return call({ port, path: '/pricing', host });
}

function tenantId(key: string): number {
  const row = writer.prepare('SELECT id FROM tenant WHERE key = ?').get(key) as { id: number } | undefined;
  assert.ok(row !== undefined, `no tenant ${key}`);
  return row.id;
}

test('two stamp reads with no write between them are equal, and neither rebuilds', () => {
  const before = { ...map.stats };
  const a = map.stamp();
  const b = map.stamp();
  assert.equal(a, b);
  assert.match(a, /^\d+:\d+$/, 'the stamp is rev || ":" || user_version');
  assert.equal(map.stats.rebuilds, before.rebuilds, 'a read with no change must not rebuild');
  assert.equal(map.stats.stampReads - before.stampReads, 2, 'two stamp() calls are two reads');
});

test('UPDATE tenant.status = suspended is visible on the next request (§5.3 row 9)', async () => {
  const warm = await get('suspend.test');
  assert.equal(warm.status, 200, 'the tenant must be serving before the flip');
  const stampBefore = map.stamp();
  writer.prepare("UPDATE tenant SET status = 'suspended' WHERE key = 'suspendme'").run();
  assert.notEqual(map.stamp(), stampBefore, 'the revision trigger did not move the stamp');
  const after = await get('suspend.test');
  assert.equal(after.status, 404, 'a suspended tenant must stop serving on the next request');
  assert.equal((after.json as { error: { code: string } }).error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('UPDATE tenant.status = archived is visible on the next request', async () => {
  assert.equal((await get('archive.test')).status, 200);
  writer.prepare("UPDATE tenant SET status = 'archived' WHERE key = 'archiveme'").run();
  assert.equal((await get('archive.test')).status, 404);
});

test("UPDATE tenant.mode = 'demo' moves the stamp and no longer changes routing (E-2 rule 4)", async () => {
  assert.equal((await get('mode.test')).status, 200);
  const stampBefore = map.stamp();
  writer.prepare("UPDATE tenant SET mode = 'demo', demo_expires_at = '2030-01-01T00:00:00.000Z' WHERE key = 'modeme'").run();
  assert.notEqual(map.stamp(), stampBefore, 'a mode flip is an UPDATE and must move the stamp');
  // E-2 rule 4: mode no longer gates the listener, and it never gated routing.
  assert.equal((await get('mode.test')).status, 200);
});

// "Newer than this image" is the image's target plus one, read from the shipped DDL: a literal 9
// here was true only until v9 shipped, and the test then asserted that a current file is stale.
test('UPDATE tenant.db_version past the image’s target is 503 SKW_E_DM_SCHEMA_STALE with Retry-After: 5', async () => {
  assert.equal((await get('version.test')).status, 200);
  const ahead = targetVersion(join(REPO, 'schema', 'site.sql')) + 1;
  writer.prepare('UPDATE tenant SET db_version = ? WHERE id = ?').run(ahead, tenantId('versionme'));
  const res = await get('version.test');
  assert.equal(res.status, 503);
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_DM_SCHEMA_STALE');
  assert.equal(res.headers['retry-after'], '5', 'the header is the contract (§4.3), not the error field');
});

test('DELETE FROM domain stops the host routing on the next request', async () => {
  assert.equal((await get('delete.test')).status, 200);
  writer.prepare("DELETE FROM domain WHERE host = 'delete.test'").run();
  const res = await get('delete.test');
  assert.equal(res.status, 404, 'a deleted host must stop routing');
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('INSERT INTO domain makes the new host serve on the next request', async () => {
  assert.equal((await get('gamma.test')).status, 404);
  writer.prepare("INSERT INTO domain (host, tenant_id, kind, is_primary) VALUES ('gamma.test', ?, 'primary', 1)").run(
    tenantId('gamma'),
  );
  const res = await get('gamma.test');
  assert.equal(res.status, 200, 'a new domain row must be served without a restart');
  assert.match(res.body, /gamma pricing/);
});

test('INSERT INTO tenant + domain serves the new tenant on the next request', async () => {
  assert.equal((await get('delta.test')).status, 404, 'the host does not exist yet');
  const info = writer
    .prepare(
      `INSERT INTO tenant (key, mode, status, display_name, db_version)
       VALUES ('delta', 'production', 'active', 'Delta', 3)`,
    )
    .run();
  const deltaId = Number(info.lastInsertRowid);
  writer.prepare("INSERT INTO domain (host, tenant_id, kind, is_primary) VALUES ('delta.test', ?, 'primary', 1)").run(deltaId);

  // The map sees the row on the very next request. Its site.db is the onboarding
  // step's job (`migrate --tenant`), not the request path's — so before that step
  // the tenant resolves and its database is unusable (row 10, 503), and after it
  // the tenant serves.
  const beforeMigrate = await get('delta.test');
  assert.notEqual(beforeMigrate.status, 404, 'the new tenant must resolve, not 404');
  assert.equal(
    (beforeMigrate.json as { error: { code: string } }).error.code,
    'SKW_E_PLT_TENANT_UNAVAILABLE',
    'no site.db yet: row 10, one code per cause',
  );
  const created = migrateTenant(fixture.sitePath('delta'), 'delta', join(REPO, 'schema'));
  assert.equal(created.ok, true, created.error ?? '');
  const delta = new Database(fixture.sitePath('delta'));
  delta
    .prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
       VALUES ('/pricing', 'pricing', 'Delta pricing', 'published', 'page', '<h1>delta pricing</h1>', '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  delta.close();
  const res = await get('delta.test');
  assert.equal(res.status, 200, 'the new tenant serves once its file exists');
  assert.match(res.body, /delta pricing/);
});

test('§5.4a — exactly one stamp read per request, and one rebuild per bump', async () => {
  const before = { ...map.stats };
  const first = await get('acme.test');
  assert.equal(first.status, 200);
  assert.equal(map.stats.stampReads - before.stampReads, 1, 'one request, one stamp read');

  // A bump, then several requests that all see it: the rebuild happens once and
  // the rest find the stamp current (single-flight by construction — the rebuild
  // is synchronous and cannot interleave).
  writer.prepare("UPDATE tenant SET display_name = 'Acme Ltd' WHERE key = 'acme'").run();
  const afterBump = { ...map.stats };
  const responses = await Promise.all([get('acme.test'), get('acme.test'), get('acme.test'), get('acme.test')]);
  for (const r of responses) assert.equal(r.status, 200);
  assert.equal(map.stats.rebuilds - afterBump.rebuilds, 1, 'one rebuild for four requests after one bump');
});
