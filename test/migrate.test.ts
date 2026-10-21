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
import { comparePlanes } from './helpers/schema.ts';
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
        // The chain's target, not a constant of nature: v5 is E-35's draft columns (S8b). What
        // this asserts is that a created file lands on the version site.sql ships.
        assert.equal(t.to, 5, `tenant ${t.key} at v5 (E-35: cms_page draft columns)`);
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
    assert.equal(created.control.to, 4, 'control.db is created at v4 (E-3, E-20)');
    assert.deepEqual(created.tenants, [], 'a control.db with no tenant rows has nothing to migrate');

    const second = runMigrations({ dataDir: fixture.dir, tenant: 'all' });
    assert.equal(second.control.action, 'skipped');
    assert.deepEqual(second.migrated, []);
  } finally {
    fixture.cleanup();
  }
});

test('a v1 site.db is migrated through the frozen chain to the shipped version', () => {
  const fixture = makeFixture({ specs: [{ key: 'legacy', hosts: ['legacy.test'], displayName: 'Legacy' }] });
  try {
    const file = fixture.sitePath('legacy');
    // Replace the v4 file with a real database built from the frozen v1 baseline.
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
    assert.equal(legacy?.to, 5);

    // The chain has to land on the shipped target shape, not merely on a version number.
    // §4.5 (E-14): the comparison is the table text (CHECKs), the trigger bodies and the
    // `(name, type, notnull)` sets — not a name-set comparison.
    const migrated = new Database(file, { readonly: true });
    const freshPath = join(fixture.dir, 'target.db');
    const fresh = new Database(freshPath);
    fresh.exec(readFileSync(join(REPO, 'schema', 'site.sql'), 'utf8'));
    try {
      comparePlanes(migrated, fresh, 'site.db v1->v5');
    } finally {
      migrated.close();
      fresh.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('E-14 negative control — dropping one CHECK from the migrated file makes the comparison go red', () => {
  const fixture = makeFixture({ specs: [{ key: 'legacy', hosts: ['legacy.test'], displayName: 'Legacy' }] });
  try {
    const file = fixture.sitePath('legacy');
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    const v1 = new Database(file);
    v1.exec(readFileSync(join(REPO, 'schema', 'history', 'v1-baseline.sql'), 'utf8'));
    v1.close();
    const report = runMigrations({ dataDir: fixture.dir, tenant: 'all' });
    assert.equal(report.tenants.find((t) => t.key === 'legacy')?.ok, true);

    const freshPath = join(fixture.dir, 'target.db');
    const fresh = new Database(freshPath);
    fresh.exec(readFileSync(join(REPO, 'schema', 'site.sql'), 'utf8'));

    // The scratch copy loses cms_download_code's `length(code_selector) = 4` CHECK — the
    // entire point of r3 — and nothing else. A `(type, name)` comparison would pass this;
    // the stronger comparison must not, and must name the table.
    const scratch = new Database(file);
    const row = scratch.prepare("SELECT sql FROM sqlite_master WHERE name = 'cms_download_code'").get() as {
      sql: string;
    };
    assert.match(row.sql, /CHECK\(length\(code_selector\) = 4\)/);
    const crippled = row.sql
      .replace(/,?\s*CHECK\(length\(code_selector\) = 4\)/, '')
      .replace(/^CREATE TABLE (?:IF NOT EXISTS )?["']?cms_download_code["']?/i, 'CREATE TABLE cms_download_code_crippled');
    const triggerRows = scratch
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND upper(sql) LIKE '%CMS_DOWNLOAD_CODE%'")
      .all() as { sql: string }[];
    try {
      // Keep the trigger set identical so the failure can only be the missing CHECK.
      scratch.exec('PRAGMA foreign_keys = OFF');
      for (const t of triggerRows) {
        const name = /CREATE TRIGGER\s+(\S+)/i.exec(t.sql)?.[1];
        if (name !== undefined) scratch.exec(`DROP TRIGGER IF EXISTS ${name}`);
      }
      scratch.exec(crippled);
      scratch.exec(
        `INSERT INTO cms_download_code_crippled
           SELECT * FROM cms_download_code`,
      );
      scratch.exec('DROP TABLE cms_download_code');
      scratch.exec('ALTER TABLE cms_download_code_crippled RENAME TO cms_download_code');
      scratch.exec('CREATE INDEX ix_code_asset ON cms_download_code(asset_id, created_at)');
      for (const t of triggerRows) scratch.exec(t.sql);

      assert.throws(
        () => comparePlanes(scratch, fresh, 'site.db'),
        /table text drift \(CHECK constraints live here\): cms_download_code/,
        'the convergence gate must name the object whose CHECK went missing',
      );
    } finally {
      scratch.close();
      fresh.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('E-6 — `legacy_alter_table` appears nowhere in the migration path', () => {
  for (const rel of ['app/db/migrate.ts', 'scripts/model/verify_claims.py']) {
    const text = readFileSync(join(REPO, rel), 'utf8');
    assert.equal(text.includes('legacy_alter_table'), false, `${rel} sets or mentions the pragma`);
  }
});

test('E-3 — a control.db at v2 migrates to v4 through r3 and r4, and control_revision holds one row', () => {
  const fixture = makeFixture({ createSiteDbs: false });
  try {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${fixture.controlDb}${suffix}`, { force: true });
    const v1 = new Database(fixture.controlDb);
    v1.exec(readFileSync(join(REPO, 'schema', 'history', 'v1-control-baseline.sql'), 'utf8'));
    v1.close();
    // v1 -> v2 first, exactly as an install that predates the seal would be.
    const r2 = new Database(fixture.controlDb);
    r2.exec(readFileSync(join(REPO, 'schema', 'control-r2.sql'), 'utf8'));
    assert.equal(Number(r2.pragma('user_version', { simple: true })), 2);
    r2.close();

    const report = runMigrations({ dataDir: fixture.dir, tenant: 'all' });
    assert.equal(report.control.ok, true, report.control.error ?? '');
    assert.equal(report.control.from, 2);
    assert.equal(report.control.to, 4);

    const db = new Database(fixture.controlDb, { readonly: true });
    try {
      assert.equal(Number(db.pragma('user_version', { simple: true })), 4);
      const rows = db.prepare('SELECT id, rev FROM control_revision').all() as { id: number; rev: number }[];
      assert.deepEqual(rows, [{ id: 1, rev: 1 }], 'exactly one revision row');
      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all() as { name: string }[];
      assert.deepEqual(triggers.map((t) => t.name), [
        'trg_audit_seal_immutable',
        'trg_domain_rev_delete',
        'trg_domain_rev_insert',
        'trg_domain_rev_update',
        'trg_tenant_rev_delete',
        'trg_tenant_rev_insert',
        'trg_tenant_rev_update',
      ]);
    } finally {
      db.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('E-20 — a v3 control.db reaches v4 with a nine-column segment seal, and its old anchors are kept in audit_log', () => {
  const fixture = makeFixture({ createSiteDbs: false });
  try {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${fixture.controlDb}${suffix}`, { force: true });
    // A control.db exactly as v3 shipped: v1 baseline, then r2 and r3.
    const v1 = new Database(fixture.controlDb);
    v1.exec(readFileSync(join(REPO, 'schema', 'history', 'v1-control-baseline.sql'), 'utf8'));
    v1.close();
    const r2 = new Database(fixture.controlDb);
    r2.exec(readFileSync(join(REPO, 'schema', 'control-r2.sql'), 'utf8'));
    r2.exec(readFileSync(join(REPO, 'schema', 'control-r3.sql'), 'utf8'));
    assert.equal(Number(r2.pragma('user_version', { simple: true })), 3);
    // A cumulative seal row of the old shape — the thing r4 cannot express as a segment.
    r2.prepare("INSERT INTO audit_seal (tenant_key, day, rows, head, sealed_at) VALUES (?, ?, ?, ?, ?)").run(
      'acme',
      '2026-10-20',
      7,
      'a'.repeat(64),
      '2026-10-21T00:00:05.000Z',
    );
    r2.close();

    const report = runMigrations({ dataDir: fixture.dir, tenant: 'all' });
    assert.equal(report.control.ok, true, report.control.error ?? '');
    assert.equal(report.control.from, 3);
    assert.equal(report.control.to, 4);

    const db = new Database(fixture.controlDb, { readonly: true });
    try {
      assert.equal(Number(db.pragma('user_version', { simple: true })), 4);
      const columns = (db.prepare("PRAGMA table_info('audit_seal')").all() as { name: string }[]).map((c) => c.name);
      assert.deepEqual(columns, ['tenant_key', 'day', 'first_id', 'last_id', 'rows_in_day', 'anchor', 'head', 'sealed_at', 'late']);
      // The old row is not a segment and is not carried: it is recorded, then replaced.
      const seals = db.prepare('SELECT count(*) AS n FROM audit_seal').get() as { n: number };
      assert.equal(seals.n, 0, 'a v3 cumulative row survived into the segment table');
      const kept = db
        .prepare("SELECT actor_label, target_kind, target_id, before_json FROM audit_log WHERE action = 'audit.seal_discarded'")
        .all() as { actor_label: string; target_kind: string; target_id: string; before_json: string }[];
      assert.equal(kept.length, 1, `the discarded anchor was not recorded: ${JSON.stringify(kept)}`);
      assert.equal(kept[0]?.actor_label, 'migration');
      assert.equal(kept[0]?.target_kind, 'audit_seal');
      assert.equal(kept[0]?.target_id, 'acme/2026-10-20');
      assert.deepEqual(JSON.parse(kept[0]?.before_json ?? '{}'), {
        rows: 7,
        head: 'a'.repeat(64),
        sealed_at: '2026-10-21T00:00:05.000Z',
      });
      // The anchor is immutable in the database, not only in the app.
      assert.equal(kept[0]?.target_id, 'acme/2026-10-20');
      assert.deepEqual(JSON.parse(kept[0]?.before_json ?? '{}'), {
        rows: 7,
        head: 'a'.repeat(64),
        sealed_at: '2026-10-21T00:00:05.000Z',
      });
    } finally {
      db.close();
    }

    const writable = new Database(fixture.controlDb);
    try {
      const insert = writable.prepare(
        `INSERT INTO audit_seal (tenant_key, day, first_id, last_id, rows_in_day, anchor, head, sealed_at, late)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run('acme', '2026-10-20', 1, 7, 7, '', 'a'.repeat(64), '2026-10-21T00:00:05.000Z', 0);
      assert.throws(
        () => writable.prepare("UPDATE audit_seal SET head = ? WHERE tenant_key = 'acme'").run('b'.repeat(64)),
        /SKW_E_SEC_AUDIT_SEAL/,
        'trg_audit_seal_immutable did not abort the UPDATE',
      );
      // A day that cannot exist is refused by the CHECK, not admitted and then unverifiable.
      assert.throws(
        () => insert.run('acme', '2026-13-01', 1, 1, 1, '', 'c'.repeat(64), '2026-14-02T00:00:00.000Z', 0),
        /CHECK constraint failed/,
        "the day CHECK admitted '2026-13-01'",
      );
      // An on-time seal (`late=0`) written on the wrong day is refused by the second CHECK.
      assert.throws(
        () => insert.run('acme', '2026-10-19', 1, 1, 1, '', 'd'.repeat(64), '2026-10-22T00:00:00.000Z', 0),
        /CHECK constraint failed/,
        'late=0 with sealed_at two days after the day was admitted',
      );
    } finally {
      writable.close();
    }
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
