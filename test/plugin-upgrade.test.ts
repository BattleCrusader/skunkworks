/**
 * Upgrading a plugin is an upgrade, not a delete-and-reinstall.
 *
 * Before this, installing a second root under one id was refused, and the only way forward was
 * `plugin uninstall` — which **drops every table the manifest declares**. "Ship contact 1.3.0" and
 * "delete every message a customer ever sent" were therefore the same instruction, which is not a
 * trade an operator can be asked to make on a live site.
 *
 * The rule now is the rule a migration has always had, and these are its witnesses:
 *
 *   U1  a new version installs over the old one through the ordinary `plugin install`
 *   U2  every row survives, and a column added by the new version is there with its default
 *   U3  the version, root hash and *enabled state* move; the operator's switch is not reset
 *   U4  a change that would drop a column is refused by name, and nothing is touched
 *   U5  a downgrade is refused: an upgrade moves forward only
 *   U6  the version being replaced is kept on disk, so a bad upgrade is reversible without a backup
 *
 * The package is synthetic on purpose: these are promises about the installer, and they must hold
 * for a package nobody has written yet.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { packageRootHash } from '../app/plugins/manifest.ts';
import { compareVersions } from '../app/plugins/upgrade.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';

const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');
const DIGEST = 'sha256:upgrade-test';

let fixture: Fixture;
let work = '';

interface Version {
  version: string;
  columns: { name: string; type: string; notNull?: boolean; default?: string | number; indexed?: boolean }[];
}

function writePackage(dir: string, spec: Version): string {
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id: 'notes',
    version: spec.version,
    main: 'index.mjs',
    hooks: [],
    description: 'a package that exists to be upgraded',
    capabilities: ['store.insert'],
    tables: [{ name: 'p_notes_note', export: 'rows', columns: spec.columns }],
    settings: [],
    endpoints: [],
  };
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, 'index.mjs'), 'export function activate() {}\n');
  return dir;
}

/** The packager's report, bound to this directory's own bytes (§8.5). */
function report(dir: string): string {
  const root = packageRootHash(dir).root;
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string; version: string };
  const out = join(work, `report-${root.slice(0, 12)}.json`);
  writeFileSync(
    out,
    JSON.stringify({
      plugin: manifest.id,
      version: manifest.version,
      root_hash: root,
      runner_image_digest: DIGEST,
      ran_at: '2026-11-17T00:00:00.000Z',
      passed: 1,
      failed: 0,
    }),
  );
  return out;
}

function install(dir: string, extra: string[] = [], plugin = 'notes'): { status: number | null; out: string } {
  const res = spawnSync(
    process.execPath,
    [CLI, 'plugin', 'install', dir, '--tenant', 'acme', '--allow-unsigned', '--test-report', report(dir), '--runner-digest', DIGEST, ...extra],
    { cwd: REPO, env: { ...process.env, SKW_DATA_DIR: fixture.dir }, encoding: 'utf8', timeout: 120_000 },
  );
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function installed(plugin = 'notes'): { version: string; root_hash: string; enabled: number } | undefined {
  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    return db.prepare('SELECT version, root_hash, enabled FROM cms_plugin_installed WHERE plugin_id = ?').get(plugin) as
      | { version: string; root_hash: string; enabled: number }
      | undefined;
  } finally {
    db.close();
  }
}

/** A manifest with full control over its tables and its `migrations` block, for the shapes `Version` cannot state. */
function writeManifest(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify({ main: 'index.mjs', hooks: [], capabilities: [], settings: [], endpoints: [], ...manifest }, null, 2)}\n`);
  writeFileSync(join(dir, 'index.mjs'), 'export function activate() {}\n');
  return dir;
}

function tableNames(): string[] {
  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'p_notes2%' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    );
  } finally {
    db.close();
  }
}

function columnsOf(table: string): string[] {
  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    return (db.pragma(`table_info("${table}")`) as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
}

function rows(): Record<string, unknown>[] {
  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    return db.prepare('SELECT * FROM p_notes_note ORDER BY id').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const V1: Version = {
  version: '1.0.0',
  columns: [
    { name: 'title', type: 'TEXT', notNull: true },
    { name: 'body', type: 'TEXT' },
  ],
};

const V2: Version = {
  version: '1.1.0',
  columns: [
    { name: 'title', type: 'TEXT', notNull: true },
    { name: 'body', type: 'TEXT' },
    // New, nullable-with-default: the one shape SQLite can add to a table that already has rows.
    { name: 'pinned', type: 'INTEGER', default: 0, indexed: true },
  ],
};

before(() => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  work = mkdtempSync(join(tmpdir(), 'skw-upgrade-'));
});

after(() => {
  fixture?.cleanup();
});

test('U1–U3. a new version installs over the old one: rows kept, column added, switch untouched', () => {
  const first = install(writePackage(join(work, 'v1'), V1), ['--enable']);
  assert.equal(first.status, 0, first.out);

  const db = new Database(fixture.sitePath('acme'));
  try {
    const insert = db.prepare('INSERT INTO p_notes_note (title, body) VALUES (?, ?)');
    insert.run('First note', 'one');
    insert.run('Second note', 'two');
    insert.run('Third note', 'three');
  } finally {
    db.close();
  }
  const v1 = installed();
  assert.equal(v1?.version, '1.0.0');
  assert.equal(v1?.enabled, 1);
  assert.equal(rows().length, 3);

  // The upgrade, through the ordinary install command — no uninstall, no ceremony.
  const second = install(writePackage(join(work, 'v2'), V2));
  assert.equal(second.status, 0, second.out);

  const v2 = installed();
  assert.equal(v2?.version, '1.1.0', 'the version must move');
  assert.notEqual(v2?.root_hash, v1?.root_hash, 'the root hash must move with it');
  // The operator turned this package on; an upgrade that quietly turned it off would be a site
  // that stopped accepting rows because someone shipped a column.
  assert.equal(v2?.enabled, 1, 'an upgrade must not reset the operator’s switch');

  const kept = rows();
  assert.equal(kept.length, 3, 'no row may be lost to an upgrade');
  assert.deepEqual(
    kept.map((r) => r['title']),
    ['First note', 'Second note', 'Third note'],
    'and they must be the same rows, in place',
  );
  // The new column exists and its declared default applied to the rows that predate it.
  assert.deepEqual(
    kept.map((r) => r['pinned']),
    [0, 0, 0],
  );

  // The package tree on the box is the new one, and the old one is kept for a rollback.
  const root = packageRootHash(join(fixture.dir, 'plugins', 'notes')).root;
  assert.equal(root, v2?.root_hash);
  const keptTree = packageRootHash(join(fixture.dir, 'plugins', 'notes.from-1.0.0')).root;
  assert.equal(keptTree, v1?.root_hash, 'the replaced version must still be on disk');
});

test('U4. a change that would drop a column is refused by name, and nothing is touched', () => {
  const before = installed();
  const destructive: Version = {
    version: '1.2.0',
    columns: [{ name: 'title', type: 'TEXT', notNull: true }], // `body` is gone
  };
  const refused = install(writePackage(join(work, 'v3'), destructive));
  assert.notEqual(refused.status, 0, 'a destructive upgrade must not be accepted');
  assert.match(refused.out, /SKW_E_PL_DESTRUCTIVE_UPGRADE/);
  assert.match(refused.out, /p_notes_note\.body/, 'the refusal must name the column');

  assert.deepEqual(installed(), before, 'a refused upgrade must not move the installed row');
  assert.equal(rows().length, 3, 'and must not touch a row');
});

test('U5. a downgrade is refused: an upgrade moves forward only', () => {
  const before = installed();
  const downgrade = install(writePackage(join(work, 'v1-again'), { ...V1, version: '0.9.0' }));
  assert.notEqual(downgrade.status, 0);
  assert.match(downgrade.out, /not newer|downgrade/i);
  assert.deepEqual(installed(), before);
  assert.equal(rows().length, 3);
});

test('U6. compareVersions orders by number, not by string', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0, '1.10.0 is newer than 1.9.0, though "1.10" sorts first as text');
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.ok(compareVersions('1.0.1', '1.0.1') === 0);
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
});

test('U7. a table the new version adds is created by the upgrade, and the old rows are untouched', () => {
  // The shape a digest needs: 1.0.0 owns one table, 1.1.0 owns two. Nothing is dropped, so nothing is
  // destructive — and the new table must appear without an uninstall, because uninstalling would
  // take the first table's rows with it.
  const v1 = writeManifest(join(work, 'n2-v1'), {
    id: 'notes2',
    version: '1.0.0',
    description: 'a package that grows a table',
    tables: [{ name: 'p_notes2_note', export: 'rows', columns: [{ name: 'title', type: 'TEXT', notNull: true }] }],
  });
  const first = install(v1, ['--enable'], 'notes2');
  assert.equal(first.status, 0, first.out);
  assert.deepEqual(tableNames(), ['p_notes2_note']);

  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare("INSERT INTO p_notes2_note (title) VALUES ('kept through the upgrade')").run();
  } finally {
    db.close();
  }

  const v2 = writeManifest(join(work, 'n2-v2'), {
    id: 'notes2',
    version: '1.1.0',
    description: 'a package that grows a table',
    tables: [
      { name: 'p_notes2_note', export: 'rows', columns: [{ name: 'title', type: 'TEXT', notNull: true }] },
      {
        name: 'p_notes2_cursor',
        export: 'empty',
        columns: [
          { name: 'last_id', type: 'INTEGER', notNull: true, default: 0 },
          { name: 'last_run_at', type: 'TEXT' },
        ],
      },
    ],
  });
  const second = install(v2, [], 'notes2');
  assert.equal(second.status, 0, second.out);
  assert.deepEqual(tableNames(), ['p_notes2_cursor', 'p_notes2_note']);
  assert.deepEqual(columnsOf('p_notes2_cursor'), ['id', 'last_id', 'last_run_at']);
  assert.equal(installed('notes2')?.version, '1.1.0');
  assert.equal(installed('notes2')?.enabled, 1, 'the operator’s switch was reset by an upgrade');
  const db2 = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    assert.equal((db2.prepare('SELECT count(*) AS n FROM p_notes2_note').get() as { n: number }).n, 1, 'the upgrade lost a row');
  } finally {
    db2.close();
  }
});

test('U8. a `migrations` block is a permission, never a statement — it must not reach SQLite as SQL', () => {
  // The refusal that found this: `ops: ["create_table"]` was pushed into the executable plan and
  // `db.exec("create_table")` died on `near "create_table": syntax error`, so every upgrade that
  // declared a migration was an install that crashed. The four op names are a vocabulary of *kinds*
  // (the DDL comes from the table diff), and a manifest string must never become a statement.
  const v3 = writeManifest(join(work, 'n2-v3'), {
    id: 'notes2',
    version: '1.2.0',
    description: 'a package that grows a table',
    migrations: [{ version: '1.2.0', seq: 1, ops: ['create_table'] }],
    tables: [
      { name: 'p_notes2_note', export: 'rows', columns: [{ name: 'title', type: 'TEXT', notNull: true }] },
      {
        name: 'p_notes2_cursor',
        export: 'empty',
        columns: [
          { name: 'last_id', type: 'INTEGER', notNull: true, default: 0 },
          { name: 'last_run_at', type: 'TEXT' },
          // The column this version adds: the reason a `migrations` block is declared at all.
          { name: 'last_slot', type: 'TEXT' },
        ],
      },
    ],
  });
  const third = install(v3, [], 'notes2');
  assert.equal(third.status, 0, third.out);
  assert.doesNotMatch(third.out, /syntax error/);
  assert.deepEqual(columnsOf('p_notes2_cursor'), ['id', 'last_id', 'last_run_at', 'last_slot']);
  assert.equal(installed('notes2')?.version, '1.2.0');
});
