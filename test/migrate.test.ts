/**
 * §16 S1 gate: "migrate exits 0 with a per-tenant report; a broken tenant 503s
 * alone — migration test with one corrupt fixture" (§12.4, C-10).
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';
import { buildApp, type AppHandle } from '../app/main.ts';
import { loadEnv } from '../app/env.ts';
import { runMigrations } from '../app/db/migrate.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';

function cli(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [join(REPO, 'app', 'db', 'migrate.ts'), ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

interface Report {
  ok: boolean;
  control: { action: string; from: number; to: number; ok: boolean; error?: string };
  tenants: { key: string; action: string; from: number; to: number; ok: boolean; error?: string }[];
  migrated: string[];
  failed: { key: string; error: string }[];
}

test('migrate creates every missing site.db from site.sql and reports per tenant, exit 0', () => {
  // createSiteDbs:false leaves acme/beta/demo-acme without a file entirely;
  // the corrupt spec still writes its garbage, so it stays broken.
  const fixture = makeFixture({ createSiteDbs: false });
  try {
    const res = cli(['--tenant', 'all'], { SKW_DATA_DIR: fixture.dir });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout) as Report;
    assert.equal(report.ok, true);
    assert.equal(report.control.action, 'skipped');
    assert.deepEqual(report.tenants.map((t) => t.key), ['acme', 'beta', 'broken', 'demo-acme']);
    for (const t of report.tenants) {
      assert.equal(t.ok, t.key !== 'broken', `tenant ${t.key}: ${t.error ?? ''}`);
      if (t.key !== 'broken') {
        assert.equal(t.action, 'created');
        assert.equal(t.to, 3, `tenant ${t.key} at v3`);
      }
    }
    assert.deepEqual(report.migrated.sort(), ['acme', 'beta', 'demo-acme']);
    assert.deepEqual(report.failed, [{ key: 'broken', error: 'SQLITE_NOTADB' }]);
  } finally {
    fixture.cleanup();
  }
});

test('control.db is created when absent, and a second run is a no-op', () => {
  const fixture = makeFixture({ createSiteDbs: false });
  try {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${fixture.controlDb}${suffix}`, { force: true });
    const first = cli(['--tenant', 'all'], { SKW_DATA_DIR: fixture.dir });
    assert.equal(first.status, 0, first.stderr);
    const created = JSON.parse(first.stdout) as Report;
    assert.equal(created.control.action, 'created');
    assert.equal(created.control.to, 2);
    assert.deepEqual(created.tenants, [], 'a control.db with no tenant rows has nothing to migrate');

    const second = runMigrations({ dataDir: fixture.dir, tenant: 'all' });
    assert.equal(second.control.action, 'skipped');
    assert.deepEqual(second.migrated, []);
  } finally {
    fixture.cleanup();
  }
});

test('a v1 site.db is migrated through the frozen chain to v3', () => {
  const fixture = makeFixture({ specs: [{ key: 'legacy', hosts: ['legacy.test'], displayName: 'Legacy' }] });
  try {
    const file = fixture.sitePath('legacy');
    // Replace the v3 file with a real database built from the frozen v1 baseline.
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    const v1 = new Database(file);
    v1.exec(readFileSync(join(REPO, 'schema', 'history', 'v1-baseline.sql'), 'utf8'));
    assert.equal(Number(v1.pragma('user_version', { simple: true })), 1);
    v1.close();

    const report = runMigrations({ dataDir: fixture.dir, tenant: 'all' });
    const legacy = report.tenants.find((t) => t.key === 'legacy');
    assert.equal(legacy?.ok, true, JSON.stringify(legacy));
    assert.equal(legacy?.action, 'migrated');
    assert.equal(legacy?.from, 1);
    assert.equal(legacy?.to, 3);

    // The chain has to land on the shipped target shape, not merely on a version number.
    const migrated = new Database(file, { readonly: true });
    const migratedObjects = migrated
      .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all();
    migrated.close();
    const freshPath = join(fixture.dir, 'target.db');
    const fresh = new Database(freshPath);
    fresh.exec(readFileSync(join(REPO, 'schema', 'site.sql'), 'utf8'));
    const targetObjects = fresh
      .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all();
    fresh.close();
    assert.deepEqual(migratedObjects, targetObjects, 'v1->v2->v3 must converge on schema/site.sql');
  } finally {
    fixture.cleanup();
  }
});

test('a control.db that cannot be migrated exits 15 and names the migration', () => {
  const fixture = makeFixture({ controlOk: false });
  try {
    const res = cli(['--tenant', 'all'], { SKW_DATA_DIR: fixture.dir });
    assert.equal(res.status, 15, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stderr, /control\.db could not be migrated/);
    assert.match(res.stderr, /SQLITE_NOTADB/);
  } finally {
    fixture.cleanup();
  }
});

test('the app refuses to boot on a control.db it cannot migrate, exit 15', () => {
  const fixture = makeFixture({ controlOk: false });
  try {
    const res = spawnSync(process.execPath, [join(REPO, 'app', 'main.ts')], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, ...fixture.env },
    });
    assert.equal(res.status, 15, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stderr, /control\.db could not be migrated/);
  } finally {
    fixture.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* "a broken tenant 503s alone": one process, one corrupt site.db, and */
/* the healthy tenants keep serving.                                    */
/* ------------------------------------------------------------------ */
test('one corrupt tenant 503s alone; the other three serve', async () => {
  const fixture = makeFixture();
  let handle: AppHandle | undefined;
  try {
    handle = await buildApp({ env: loadEnv(fixture.env) });
    await handle.app.listen({ port: 0, host: '127.0.0.1' });
    const address = handle.app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const broken = await call({ port, path: '/pricing', host: 'broken.test' });
    assert.equal(broken.status, 503);
    assert.equal((broken.json as { error: { code: string } }).error.code, 'SKW_E_PLT_TENANT_UNAVAILABLE');

    for (const host of ['acme.test', 'beta.test']) {
      const ok = await call({ port, path: '/pricing', host });
      assert.equal(ok.status, 200, `${host} must keep serving`);
    }
  } finally {
    await handle?.close();
    fixture.cleanup();
  }
});
