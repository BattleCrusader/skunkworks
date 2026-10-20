/**
 * S4c item 1 — **`install.sh` against a real CMS bundle, on a clean directory** (§11.6,
 * E-19, D30; S4b report §9.1).
 *
 * S4b shipped a bundle and said, in the report, that nothing had ever run its
 * `install.sh`: the script is copied into the bundle, the bundle now carries every path
 * the script reads, and no gate drove it. This file drives it — the bundle is copied into
 * a fresh empty directory, the *bundle's own* script runs there, and the assertions are
 * made against what the filesystem and `control.db` say afterwards.
 *
 * Five refusals/outcomes that only a real install can show:
 *
 *   I1  exit 0, `control.db` at `control.sql`'s version (**4**), one seeded tenant, the
 *       bundle's `data/site.db` installed as that tenant's database, `first-login.txt`
 *       `0600`, `bundle_verify` **reached** and its verdict honoured, and the installed
 *       box serving a page.
 *   I2  a second run is **idempotent**: exit 0, no second seed, no changed row.
 *   I3  a stale seed (`schema_version: 3` against `control.sql`'s 4) is refused by name
 *       instead of seeding a database it does not describe.
 *   I4  a tampered bundle exits 12 **before** `control.db` exists: the verdict is honoured,
 *       not merely reached.
 *   I5  a bundle carrying `cms_plugin_installed` rows and no package is refused, naming
 *       the plugin and the row — the gap S4b §9.2 named.
 *   I6  an existing enrolment file is not overwritten (`O_EXCL`), and the install refuses.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO } from './helpers/fixture.ts';
import { makeBundle, type BundleOptions } from './helpers/bundle.ts';

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Copy a bundle into a fresh directory: the "empty host directory" of §16's S4 row. */
function host(bundle: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'skw-host-'));
  cpSync(bundle, dir, { recursive: true, verbatimSymlinks: true });
  return dir;
}

function install(dir: string, extra: readonly string[] = []): Run {
  const res = spawnSync('./install.sh', ['--no-compose', '--skip-dns', '--runtime', REPO, ...extra], {
    cwd: dir,
    env: { ...process.env, SKW_ENV_FILE: join(dir, '.env') },
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function read(dbPath: string, sql: string, params: readonly unknown[] = []): unknown {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Object.values(row)[0];
  } finally {
    db.close();
  }
}

function readRow(dbPath: string, sql: string): Record<string, unknown> | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).get() as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

function make(opts: BundleOptions = {}): { host: string; bundleDir: string; cleanup(): void } {
  const bundle = makeBundle(opts);
  const dir = host(bundle.dir);
  return {
    host: dir,
    bundleDir: bundle.dir,
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
      bundle.cleanup();
    },
  };
}

/**
 * Recompute one file's `sha256` in `BUNDLE.json` after editing it.
 *
 * This is how a bundle produced by a **buggy exporter** looks: every hash agrees, and the
 * content is wrong in a way hashing cannot see (a plugin row with no package, a seed that
 * names the wrong schema version). Without it, every such fixture would exit 12 on the
 * sha256 first and the refusal under test would never run.
 */
function reseal(dir: string, rel: string): void {
  const path = join(dir, 'BUNDLE.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    files: { path: string; sha256: string; bytes: number }[];
  };
  const entry = manifest.files.find((f) => f.path === rel);
  if (entry === undefined) throw new Error(`${rel} is not in BUNDLE.json`);
  const bytes = readFileSync(join(dir, rel));
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  entry.bytes = bytes.byteLength;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

test('I1 — a bundled install reaches a served page, at schema v4, with the tenant seeded', () => {
  const b = make();
  try {
    const run = install(b.host, ['--verify-login']);
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);

    // 1. bundle_verify was reached, and its verdict was "clean".
    assert.match(run.stdout, /verify: BUNDLE\.json present, checking every sha256/);
    assert.match(run.stdout, /bundle_verify: \d+ file\(s\) verified, no render tree, no render rows/, 'the verdict is honoured');

    // 2. control.db is at control.sql's version, not the seed's stale claim.
    assert.equal(read(join(b.host, 'data', 'control.db'), 'PRAGMA user_version'), 4, 'control.db is v4');
    assert.match(run.stdout, /schema: control\.sql applied to .* \(v4\)/);

    // 3. one tenant, seeded once, with its site database installed where the app looks.
    const tenants = readRow(join(b.host, 'data', 'control.db'), 'SELECT key, mode, status FROM tenant');
    assert.deepEqual(tenants, { key: 'acme', mode: 'production', status: 'active' });
    assert.equal(existsSync(join(b.host, 'data', 'tenants', 'acme', 'site.db')), true, 'the tenant database is installed');
    assert.equal(read(join(b.host, 'data', 'tenants', 'acme', 'site.db'), 'SELECT count(*) FROM cms_page'), 2);

    // 4. the enrolment file is 0600 and carries the three fields D30 promises.
    const enrolment = join(b.host, 'data', 'first-login.txt');
    assert.equal((statSync(enrolment).mode & 0o777).toString(8), '600');
    const text = readFileSync(enrolment, 'utf8');
    assert.match(text, /^uri:\s+otpauth:\/\/totp\//m);
    assert.match(text, /^password:\s+\S{16,}$/m);

    // 5. the box serves a page: the installer's own login smoke test proves the admin
    //    surface, and the page probe proves the public one.
    assert.match(run.stdout, /install_check: signed in as owner@acme\.test, GET \/admin 200/);
    assert.match(run.stdout, /install_check: GET \/ 200 .*Acme home/);
  } finally {
    b.cleanup();
  }
});

test('I2 — installing the same directory twice is idempotent: exit 0, no second seed, no changed row', () => {
  const b = make();
  try {
    const first = install(b.host);
    assert.equal(first.status, 0, first.stderr);
    const db = join(b.host, 'data', 'control.db');
    const before = read(db, 'SELECT password_hash, totp_secret, must_change FROM user_account WHERE email = ?', [
      'owner@acme.test',
    ]);

    const second = install(b.host);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /schema: .* exists, left alone/);
    assert.match(second.stdout, /seed: tenants already present, left alone/);
    assert.match(second.stdout, /bootstrap: this box is already set up; nothing changed \(exit 3\)/);
    assert.deepEqual(
      read(db, 'SELECT password_hash, totp_secret, must_change FROM user_account WHERE email = ?', ['owner@acme.test']),
      before,
    );
    assert.equal(read(db, 'SELECT count(*) FROM tenant'), 1, 'a second run does not seed a second tenant');
  } finally {
    b.cleanup();
  }
});

test('I3 — a v3 seed handed to the installer is refused, naming both versions, and seeds nothing', () => {
  const b = make();
  try {
    // Outside the bundle, so `bundle_verify` has no opinion about it: this is the
    // `--seed FILE` path an operator reaches for when they think they know better.
    const stale = join(b.host, 'stale.seed.json');
    const seed = JSON.parse(readFileSync(join(b.host, 'data', 'control.seed.json'), 'utf8')) as Record<string, unknown>;
    seed.schema_version = 3;
    writeFileSync(stale, JSON.stringify(seed, null, 2));

    const run = install(b.host, ['--seed', stale]);
    assert.equal(run.status, 15, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stderr, /seed_control: REFUSAL: .*schema_version 3.*control\.db, which is 4/);
    assert.equal(read(join(b.host, 'data', 'control.db'), 'SELECT count(*) FROM tenant'), 0, 'nothing was seeded');
  } finally {
    b.cleanup();
  }
});

test('I3b — a bundle whose own seed says v3 is refused by the verifier before control.db exists', () => {
  const b = make();
  try {
    const seedPath = join(b.host, 'data', 'control.seed.json');
    const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Record<string, unknown>;
    seed.schema_version = 3;
    writeFileSync(seedPath, JSON.stringify(seed, null, 2));
    reseal(b.host, 'data/control.seed.json');

    const run = install(b.host);
    assert.equal(run.status, 12, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stderr, /schema_version 3 but schema\/control\.sql declares 4/);
    assert.equal(existsSync(join(b.host, 'data', 'control.db')), false);
  } finally {
    b.cleanup();
  }
});

test('I4 — a tampered bundle is refused with exit 12 before control.db exists', () => {
  const b = make();
  try {
    writeFileSync(join(b.host, 'EXPORT-NOTES.md'), 'tampered\n');
    const run = install(b.host);
    assert.equal(run.status, 12, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stderr, /bundle_verify: REFUSAL: sha256 mismatch: EXPORT-NOTES\.md/);
    assert.equal(existsSync(join(b.host, 'data', 'control.db')), false, 'a refused bundle creates nothing');
  } finally {
    b.cleanup();
  }
});

test('I5 — a bundle with cms_plugin_installed rows and no package is refused, naming plugin and row', () => {
  const b = make();
  try {
    // The row is inserted **after** the export and the manifest resealed: this is a bundle
    // written by an exporter that shipped the row and no code, which is exactly what S4b's
    // `planCms()` did (`plugins: []` unconditionally).
    const site = join(b.host, 'data', 'site.db');
    const db = new Database(site);
    try {
      db.prepare(
        `INSERT INTO cms_plugin_installed
           (plugin_id, version, manifest_json, root_hash, publisher, signature_state, enabled, test_report_sha)
         VALUES ('contact', '1.4.0', ?, ?, 'acme-publisher', 'unsigned', 1, ?)`,
      ).run(JSON.stringify({ id: 'contact', version: '1.4.0', capabilities: ['util.now'] }), 'a'.repeat(64), 'b'.repeat(64));
    } finally {
      db.close();
    }
    reseal(b.host, 'data/site.db');

    const run = install(b.host);
    assert.equal(run.status, 12, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stderr, /bundle_verify: REFUSAL: .*plugin contact \(cms_plugin_installed row 1\) has no package/);
    assert.equal(existsSync(join(b.host, 'data', 'control.db')), false, 'nothing is installed from such a bundle');
  } finally {
    b.cleanup();
  }
});

test('I5b — the exporter refuses to *produce* a bundle for a tenant with an installed plugin', () => {
  const bundle = makeBundle();
  try {
    const db = new Database(bundle.fixture.sitePath('acme'));
    try {
      db.prepare(
        `INSERT INTO cms_plugin_installed
           (plugin_id, version, manifest_json, root_hash, publisher, signature_state, enabled, test_report_sha)
         VALUES ('contact', '1.4.0', ?, ?, 'acme-publisher', 'unsigned', 1, ?)`,
      ).run(JSON.stringify({ id: 'contact', version: '1.4.0' }), 'a'.repeat(64), 'b'.repeat(64));
    } finally {
      db.close();
    }
    const out = mkdtempSync(join(tmpdir(), 'skw-refused-'));
    try {
      const res = spawnSync(
        'node',
        [
          'app/cli/export.ts',
          '--target', 'cms',
          '--tenant', 'acme',
          '--out', out,
          '--data-dir', bundle.fixture.dir,
          '--now', '2026-10-20T12:00:00.000Z',
        ],
        { cwd: REPO, encoding: 'utf8', timeout: 120_000 },
      );
      assert.equal(res.status, 20, `${res.stderr}\n${res.stdout}`);
      assert.match(res.stderr, /SKW_E_PL_EXPORT_PACKAGE_MISSING/);
      assert.match(res.stderr, /"id":1,"plugin":"contact","version":"1\.4\.0"/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  } finally {
    bundle.cleanup();
  }
});

test('I7 — re-cutting a bundle from the installed tree does not destroy that tree\'s data/site.db', () => {
  const b = make();
  try {
    const run = install(b.host);
    assert.equal(run.status, 0, run.stderr);
    const shipped = join(b.host, 'data', 'site.db');
    assert.equal(existsSync(shipped), true, 'the bundle ships data/site.db');
    const before = createHash('sha256').update(readFileSync(shipped)).digest('hex');

    // The operator's next move after an edit: export again, from the installed data
    // directory. `planCms()`'s temporary used to be called `site.db` in exactly that
    // directory — it overwrote this file and then deleted it (S4c finding).
    const out = join(b.host, 'recut');
    const res = spawnSync(
      'node',
      ['app/cli/export.ts', '--target', 'cms', '--tenant', 'acme', '--out', out, '--data-dir', join(b.host, 'data'), '--now', '2026-10-20T12:00:00.000Z'],
      { cwd: REPO, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`);

    assert.equal(existsSync(shipped), true, "the installed tree's data/site.db survives a re-export");
    assert.equal(createHash('sha256').update(readFileSync(shipped)).digest('hex'), before, 'and is byte-identical');
  } finally {
    b.cleanup();
  }
});

test('I6 — an existing enrolment file is not overwritten: bootstrap refuses and the bytes survive', () => {
  const b = make();
  try {
    const enrolment = join(b.host, 'data', 'first-login.txt');
    // `data/` is the bundle's own directory; the file exists before the install runs.
    writeFileSync(enrolment, 'previous enrolment\n', { mode: 0o600 });
    const run = install(b.host);
    assert.equal(run.status, 16, `${run.stderr}\n${run.stdout}`);
    assert.equal(readFileSync(enrolment, 'utf8'), 'previous enrolment\n', 'O_EXCL: the earlier credential is untouched');
  } finally {
    b.cleanup();
  }
});
