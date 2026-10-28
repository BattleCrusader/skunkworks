/**
 * S5 item 2 — **`activation_seq` as a column** (02-errata E-31 item 5).
 *
 * The cache-buster started life as a process-wide counter. That is enough for Node's ESM cache
 * *inside one process* — and `plugin-load.test.ts` L9 proves it there — but a new process
 * starts at zero, hands `import()` the URL the previous process used, and receives the module
 * namespace that process already evaluated, with its module-level state and its timers. The
 * counter has to be in the row or "a restart loaded the package again" is luck.
 *
 *   A1  the column exists in the DDL a fresh tenant gets, with `DEFAULT 0` and the CHECK
 *   A2  enable writes the number the URL carried; disable→enable goes 1 → 2 in one process
 *   A3  **a restart**: two separate OS processes continue the sequence from the row alone,
 *       and each one's module reports the number its own URL carried (`?act=`)
 *   A4  a v3 database migrates to v4 by `r4-amendments.sql`, keeps its rows, and seeds them 0
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { migrateTenant } from '../app/db/migrate.ts';
import { installPlugin } from '../app/plugins/install.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { PluginRuntime } from '../app/plugins/runtime.ts';
import { SCHEMA, REPO, makeFixture, type Fixture } from './helpers/fixture.ts';

const TENANT = 'acme';
const DIGEST = 'sha256:s5-actseq-app';
const ACTSEQ = join(REPO, 'test', 'fixtures', 'plugins', 'actseq');
const CHILD = join(REPO, 'test', 'helpers', 'actseq-child.ts');

let fixture: Fixture;
let runtime: PluginRuntime;

function siteDbFile(): string {
  return fixture.sitePath(TENANT);
}

function rowSeq(): number {
  const db = new Database(siteDbFile(), { readonly: true });
  try {
    return Number((db.prepare(`SELECT activation_seq FROM cms_plugin_installed WHERE plugin_id = 'actseq'`).get() as { activation_seq: number }).activation_seq);
  } finally {
    db.close();
  }
}

/** What the package itself read out of its own `import.meta.url`, via `page.head`. */
async function actFromModule(rt: PluginRuntime): Promise<string> {
  return rt.hooks.dispatchFilter<string>('page.head', TENANT, { tenant: TENANT, path: '/' }, '', rt.registry.hooksFor(TENANT, 'page.head'));
}

function child(): { seq: number; head: string; status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, [CHILD, fixture.dir, TENANT, 'actseq'], { cwd: REPO, encoding: 'utf8' });
  const line = (run.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '';
  const parsed = line === '' ? { seq: -1, head: '' } : (JSON.parse(line) as { seq: number; head: string });
  return { ...parsed, status: run.status, stderr: run.stderr ?? '' };
}

before(() => {
  fixture = makeFixture({ specs: [{ key: TENANT, hosts: ['acme.test'], title: 'Acme' }] });
  const root = packageRootHash(ACTSEQ).root;
  const report = join(fixture.dir, 'actseq-report.json');
  writeFileSync(
    report,
    `${JSON.stringify({ plugin: 'actseq', version: '1.0.0', root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  installPlugin({
    siteDb: siteDbFile(),
    pluginsRoot: join(fixture.dir, 'plugins'),
    sourceDir: ACTSEQ,
    allowUnsigned: true,
    testReportPath: report,
    runnerImageDigest: DIGEST,
  });
  runtime = new PluginRuntime({ dataDir: fixture.dir, emailMode: 'off' });
});

after(() => {
  fixture.cleanup();
});

test('A1. the DDL a fresh tenant gets carries activation_seq, DEFAULT 0, and the CHECK', () => {
  const ddl = readFileSync(join(SCHEMA, 'site.sql'), 'utf8');
  assert.match(ddl, /activation_seq INTEGER NOT NULL DEFAULT 0 CHECK\(activation_seq >= 0\)/);
  // The DDL's own version, asserted so this file cannot silently test a database it did not
  // create. It moves with schema/site.sql (v9 since S9's cms_application).
  assert.match(ddl, /PRAGMA user_version = 9;/);
  const db = new Database(siteDbFile(), { readonly: true });
  try {
    const columns = db.pragma('table_info(cms_plugin_installed)') as { name: string; dflt_value: string | null; notnull: number }[];
    const column = columns.find((c) => c.name === 'activation_seq');
    assert.ok(column !== undefined, 'the column is not in the created database');
    assert.equal(column.dflt_value, '0');
    assert.equal(column.notnull, 1);
  } finally {
    db.close();
  }
});

test('A2. enable writes the number the URL carried; disable→enable goes 1 → 2', async () => {
  const first = await runtime.enable(TENANT, 'actseq');
  assert.equal(first.activationSeq, 1);
  assert.equal(rowSeq(), 1);
  assert.equal(await actFromModule(runtime), '<!--act:1-->', 'the module must have imported the URL with act=1');

  await runtime.disable(TENANT, 'actseq');
  const second = await runtime.enable(TENANT, 'actseq');
  assert.equal(second.activationSeq, 2);
  assert.equal(rowSeq(), 2);
  assert.equal(await actFromModule(runtime), '<!--act:2-->', 'a new module instance must have read act=2');
});

test('A3. a restart continues from the row: two processes, two new numbers', () => {
  const before = rowSeq();
  assert.equal(before, 2);

  const one = child();
  assert.equal(one.status, 0, `child 1 failed: ${one.stderr}`);
  assert.equal(one.seq, 3, 'the first process after a restart must continue from the row, not from zero');
  assert.equal(one.head, '<!--act:3-->', 'the module must have been imported with act=3');
  assert.equal(rowSeq(), 3);

  const two = child();
  assert.equal(two.status, 0, `child 2 failed: ${two.stderr}`);
  assert.equal(two.seq, 4);
  assert.equal(two.head, '<!--act:4-->');
  assert.equal(rowSeq(), 4);

  // The point of the whole item: without the column both children would have said 1, and the
  // ESM cache would have handed back a namespace the previous process had already evaluated.
  assert.notEqual(one.seq, two.seq);
});

test('A4. a v3 database migrates forward, keeps its rows, and seeds them 0', () => {
  // Build a v3 shape by removing everything the chain added after v3, then let the real
  // migration put it back. Both deltas have to be undone or the migration refuses the fixture
  // for the wrong reason: r4 adds `activation_seq`, r5 adds the four `draft_*` columns.
  const path = join(fixture.dir, 'tenants', 'v3', 'site.db');
  mkdirSync(dirname(path), { recursive: true });
  const v3 = new Database(path);
  try {
    v3.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
    v3.exec('ALTER TABLE cms_plugin_installed DROP COLUMN activation_seq');
    v3.exec('ALTER TABLE cms_page DROP COLUMN draft_html');
    v3.exec('ALTER TABLE cms_page DROP COLUMN draft_css');
    v3.exec('ALTER TABLE cms_page DROP COLUMN draft_sha');
    v3.exec('ALTER TABLE cms_page DROP COLUMN draft_updated_at');
    // ... and everything the chain added after v3 *structurally*, which since E-54 is three tables.
    // Without this the r6/r7 deltas would run against a file that already has them and refuse.
    v3.exec('DROP TABLE cms_theme_asset');
    v3.exec('DROP TABLE cms_theme');
    v3.exec('DROP TABLE cms_css_blob');
    // S9 added eight tables in two deltas (r8: the board's people; r9: the application, which
    // references cms_account twice). A v3 fixture built from today's DDL has them, and r8/r9 would
    // then fail on CREATE TABLE rather than converge. Children first, because the FKs are real:
    // cms_application before cms_account, or the DROP is refused.
    for (const table of [
      'cms_application',
      'cms_mail_suppression',
      'cms_mail',
      'cms_profile',
      'cms_account_session',
      'cms_account_token',
      'cms_account_role',
      'cms_account',
    ]) {
      v3.exec(`DROP TABLE ${table}`);
    }
    v3.exec('DROP INDEX IF EXISTS ix_cta_theme');
    v3.exec('DROP INDEX IF EXISTS ix_ct_created');
    v3.exec('DROP INDEX IF EXISTS ix_ccb_created');
    v3.pragma('user_version = 3');
    v3.prepare(
      `INSERT INTO cms_plugin_installed
         (plugin_id, version, manifest_json, root_hash, publisher, signature_state, enabled, test_report_sha)
       VALUES ('actseq', '1.0.0', '{}', ?, 'unsigned', 'unsigned', 0, 'sha256:x')`,
    ).run('a'.repeat(64));
  } finally {
    v3.close();
  }

  const before = new Database(path, { readonly: true });
  try {
    assert.equal(Number(before.pragma('user_version', { simple: true })), 3);
    const names = (before.pragma('table_info(cms_plugin_installed)') as { name: string }[]).map((c) => c.name);
    assert.equal(names.includes('activation_seq'), false, 'the fixture must really be a v3 shape');
  } finally {
    before.close();
  }

  const report = migrateTenant(path, 'v3', SCHEMA);
  assert.equal(report.ok, true, report.error);
  assert.equal(report.action, 'migrated');
  assert.equal(report.from, 3);
  assert.equal(report.to, 9);

  const after = new Database(path, { readonly: true });
  try {
    assert.equal(Number(after.pragma('user_version', { simple: true })), 9);
    const row = after.prepare(`SELECT activation_seq FROM cms_plugin_installed WHERE plugin_id = 'actseq'`).get() as
      | { activation_seq: number }
      | undefined;
    assert.ok(row !== undefined, 'the migration must not drop an installed package');
    assert.equal(row.activation_seq, 0, 'a package that has never been activated on this file is 0');
  } finally {
    after.close();
  }
});
