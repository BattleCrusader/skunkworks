/**
 * S4d follow-up — **the operator surface for a plugin on a running box.**
 *
 * S4d shipped `installPlugin()` as a library entry point and `planCms()` that ships the
 * package, but nothing an operator can run: installing a plugin meant writing code against
 * the module graph. §8.2's install row is an operator decision (which third-party code runs
 * on the client's site), so it needs a shell surface, and the S4d report named its absence.
 *
 * These gates drive `app/cli/skwctl.ts` as the operator does — a child process, the
 * fixture's own env, no HTTP — and prove the chain end to end:
 *
 *   O1  `plugin install` copies the package where compose mounts `/srv/plugins`, writes the
 *       row, and the **exporter then ships that exact package** and `bundle_verify` accepts
 *       it. That is the full route: install → export → install on a client's box.
 *   O2  `plugin disable` / `plugin enable` flip the row, and enable refuses an untested
 *       package — the same rule `assertEnabled()` enforces at render time.
 *   O3  refusals are named and exit 1: an unknown plugin, a missing `--tenant`, and a
 *       package with no test report. Nothing is installed by a refusal.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';

import { openAdminWrite } from '../app/db/classes.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

let fixture: Fixture;
let source = '';
let report = '';

function skwctl(args: readonly string[], env: Record<string, string> = fixture.env): Run {
  const res = spawnSync(process.execPath, ['app/cli/skwctl.ts', ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** One package, and the test report that names its root — what a packager hands over. */
function packageAt(dir: string, id: string, withReport: boolean): void {
  mkdirSync(dir, { recursive: true });
  const manifest = { id, version: '1.4.0', entry: 'index.mjs', capabilities: [], tables: [], settings: [] };
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, 'index.mjs'), 'export default {};\n');
  if (!withReport) return;
  const root = packageRootHash(dir).root;
  writeFileSync(
    report,
    `${JSON.stringify({ plugin: id, version: '1.4.0', root_hash: root, runner_image_digest: 'sha256:cli-test', ran_at: '2026-10-21T00:00:00.000Z' }, null, 2)}\n`,
  );
}

function row(): Record<string, unknown> | undefined {
  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    return db.prepare('SELECT id, plugin_id, version, root_hash, enabled, test_report_sha FROM cms_plugin_installed').get() as
      | Record<string, unknown>
      | undefined;
  } finally {
    db.close();
  }
}

before(() => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  source = join(fixture.dir, 'packages', 'contact');
  report = join(fixture.dir, 'contact-report.json');
  packageAt(source, 'contact', true);
});

after(() => {
  fixture.cleanup();
});

test('O1 — plugin install puts the package where compose mounts it, and the exporter ships it to a client', () => {
  // S4f: an unsigned package needs the flag, and the flag is loud. `contact` is built by this
  // gate without a signature, which is exactly the operator case the flag exists for.
  const installed = skwctl([
    'plugin',
    'install',
    source,
    '--tenant',
    'acme',
    '--test-report',
    report,
    '--runner-digest',
    'sha256:cli-test',
    '--allow-unsigned',
    '--enable',
  ]);
  assert.equal(installed.status, 0, `${installed.stderr}\n${installed.stdout}`);
  assert.match(installed.stdout, /\*\*\* UNSIGNED/);
  assert.match(installed.stdout, /plugin: installed id=contact version=1\.4\.0 .*enabled=yes/);
  // The code is not live until the runner reloads its registry; a green install that did not
  // say so is how a plugin 500s on the client's first render.
  assert.match(installed.stdout, /the runner scans .* at start; restart the runner service to load contact/);
  assert.equal(existsSync(join(fixture.dir, 'plugins', 'contact', 'plugin.json')), true, 'the package is not at <data>/plugins/contact');

  const installedRow = row();
  assert.equal(installedRow?.plugin_id, 'contact');
  assert.equal(installedRow?.enabled, 1);
  assert.equal(String(installedRow?.root_hash), packageRootHash(source).root);

  // The operator's next step: export the tenant. The bundle must carry the row *and* the
  // bytes, and the verifier the client runs must accept the producer's output.
  const out = mkdtempSync(join(tmpdir(), 'skw-cli-bundle-'));
  try {
    const exported = spawnSync(
      process.execPath,
      ['app/cli/export.ts', '--target', 'cms', '--tenant', 'acme', '--out', out, '--data-dir', fixture.dir, '--now', '2026-10-21T00:00:00.000Z'],
      { cwd: REPO, env: { ...process.env, ...fixture.env }, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(exported.status, 0, `${exported.stderr}\n${exported.stdout}`);
    assert.equal(existsSync(join(out, 'data', 'plugins', 'contact', 'index.mjs')), true, 'the exported bundle has no package');
    const manifest = JSON.parse(readFileSync(join(out, 'BUNDLE.json'), 'utf8')) as { plugins: { id: string; root_hash: string }[] };
    assert.deepEqual(manifest.plugins.map((p) => [p.id, p.root_hash]), [['contact', packageRootHash(source).root]]);

    const verified = spawnSync(process.execPath, ['tools/bundle_verify.mjs', '--bundle', out], { cwd: REPO, encoding: 'utf8' });
    assert.equal(verified.status, 0, `${verified.stderr}\n${verified.stdout}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('O2 — plugin disable and enable flip the row, and enable refuses a package nobody tested', () => {
  const disabled = skwctl(['plugin', 'disable', 'contact', '--tenant', 'acme']);
  assert.equal(disabled.status, 0, `${disabled.stderr}\n${disabled.stdout}`);
  assert.equal(row()?.enabled, 0);

  const enabled = skwctl(['plugin', 'enable', 'contact', '--tenant', 'acme']);
  assert.equal(enabled.status, 0, `${enabled.stderr}\n${enabled.stdout}`);
  assert.equal(row()?.enabled, 1);

  // Remove the test report from the row: an enabled package with no report is exactly what
  // `assertEnabled()` refuses at render time, so the operator surface must refuse it first.
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    db.prepare("UPDATE cms_plugin_installed SET test_report_sha = NULL, enabled = 0 WHERE plugin_id = 'contact'").run();
  } finally {
    db.close();
  }
  const refused = skwctl(['plugin', 'enable', 'contact', '--tenant', 'acme']);
  assert.equal(refused.status, 1, `${refused.stderr}\n${refused.stdout}`);
  assert.match(refused.stderr, /REFUSAL: PLUGIN_REFUSED: .*no test report/);
  assert.equal(row()?.enabled, 0, 'a refused enable flips nothing');
});

test('O3 — refusals are named and write nothing', () => {
  const unknown = skwctl(['plugin', 'enable', 'ghost', '--tenant', 'acme']);
  assert.equal(unknown.status, 1, `${unknown.stderr}\n${unknown.stdout}`);
  assert.match(unknown.stderr, /REFUSAL: PLUGIN_UNKNOWN: no cms_plugin_installed row for ghost/);

  const noTenant = skwctl(['plugin', 'list']);
  assert.equal(noTenant.status, 1, `${noTenant.stderr}\n${noTenant.stdout}`);
  assert.match(noTenant.stderr, /REFUSAL: USAGE: .*--tenant/);

  const untested = join(fixture.dir, 'packages', 'untested');
  packageAt(untested, 'untested', false);
  const refused = skwctl(['plugin', 'install', untested, '--tenant', 'acme', '--runner-digest', 'sha256:cli-test', '--allow-unsigned', '--enable']);
  assert.equal(refused.status, 1, `${refused.stderr}\n${refused.stdout}`);
  assert.match(refused.stderr, /REFUSAL: PLUGIN_REFUSED: SKW_E_PL_TESTS_STALE: no test report/);
  assert.equal(existsSync(join(fixture.dir, 'plugins', 'untested')), false, 'a refused install copies nothing');
});

/**
 * §8.6's uninstall row, and §8.2's archive. The point of the gate is that "uninstalled" is a
 * state the box can prove: the row, the declared table, its registry entries and the package
 * tree all go, the data is in an archive an operator can read, and a second uninstall refuses
 * rather than pretending twice.
 */
function packageWithTable(dir: string, id: string, table: string): void {
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    version: '1.4.0',
    entry: 'index.mjs',
    capabilities: [],
    tables: [{ name: table, export: 'rows', columns: [{ name: 'body', type: 'TEXT', indexed: true }] }],
    settings: [{ key: 'signature', type: 'string', max: 120 }],
  };
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, 'index.mjs'), 'export default {};\n');
  const root = packageRootHash(dir).root;
  writeFileSync(
    report,
    `${JSON.stringify({ plugin: id, version: '1.4.0', root_hash: root, runner_image_digest: 'sha256:cli-test', ran_at: '2026-10-21T00:00:00.000Z' }, null, 2)}\n`,
  );
}

test('O4 — install → uninstall archives the plugin’s rows, drops its tables, and leaves the box clean', () => {
  const source = join(fixture.dir, 'packages', 'guestbook');
  packageWithTable(source, 'guestbook', 'p_guestbook_note');
  const installed = skwctl([
    'plugin',
    'install',
    source,
    '--tenant',
    'acme',
    '--test-report',
    report,
    '--runner-digest',
    'sha256:cli-test',
    '--allow-unsigned',
    '--enable',
  ]);
  assert.equal(installed.status, 0, `${installed.stderr}\n${installed.stdout}`);

  // Two rows and a setting, written by the host (the only writer §8.3 allows).
  const write = openAdminWrite(fixture.sitePath('acme'));
  let archivePath = '';
  try {
    write.prepare("INSERT INTO p_guestbook_note (body) VALUES ('first note'), ('second note')").run();
    write
      .prepare("INSERT INTO cms_plugin_setting (plugin_id, key, value_json, type, secret) VALUES ('guestbook', 'signature', '\"hello\"', 'string', 0)")
      .run();
    const before = write.prepare('SELECT count(*) AS n FROM p_guestbook_note').get() as { n: number };
    assert.equal(before.n, 2);
  } finally {
    write.close();
  }

  const archiveDir = join(fixture.dir, 'plugin-archive');
  const removed = skwctl(['plugin', 'uninstall', 'guestbook', '--tenant', 'acme', '--archive-dir', archiveDir]);
  assert.equal(removed.status, 0, `${removed.stderr}\n${removed.stdout}`);
  assert.match(removed.stdout, /plugin: uninstalled id=guestbook version=1\.4\.0 .*tables=p_guestbook_note\(2\) settings=1/);
  assert.match(removed.stdout, /plugin: restart the runner service to release the code for guestbook/);

  // The archive is real, 0600, table-scoped, and contains the rows (the register's O-40
  // "v2 experiment", delivered): restoring it cannot roll back unrelated tenant edits.
  archivePath = /plugin: archive (\S+)/.exec(removed.stdout)?.[1] ?? '';
  assert.notEqual(archivePath, '', 'the uninstall printed no archive path');
  assert.equal(existsSync(archivePath), true, `no archive at ${archivePath}`);
  const mode = (statSync(archivePath).mode & 0o777).toString(8);
  assert.equal(mode, '600', `archive mode is ${mode}, not 600`);
  const archive = JSON.parse(readFileSync(archivePath, 'utf8')) as {
    format: string;
    plugin: string;
    tables: { name: string; rows: Record<string, unknown>[] }[];
    settings: { key: string; value_json: string | null }[];
  };
  assert.equal(archive.format, 'skw-plugin-archive/1');
  assert.equal(archive.plugin, 'guestbook');
  assert.equal(archive.tables[0]?.name, 'p_guestbook_note');
  assert.deepEqual(archive.tables[0]?.rows.map((r) => r.body), ['first note', 'second note']);
  assert.equal(archive.settings[0]?.key, 'signature');

  // Clean: the row, the table, its registry entries and the package tree are gone.
  const after = openAdminWrite(fixture.sitePath('acme'));
  try {
    const exists = after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='p_guestbook_note'").get();
    assert.equal(exists, undefined, 'the plugin table survived the uninstall');
    const rows = after.prepare("SELECT count(*) AS n FROM cms_plugin_installed WHERE plugin_id='guestbook'").get() as { n: number };
    assert.equal(rows.n, 0, 'the cms_plugin_installed row survived');
    const registry = after.prepare("SELECT count(*) AS n FROM cms_table_registry WHERE plugin_id='guestbook'").get() as { n: number };
    assert.equal(registry.n, 0, 'the cms_table_registry row survived');
    const settings = after.prepare("SELECT count(*) AS n FROM cms_plugin_setting WHERE plugin_id='guestbook'").get() as { n: number };
    assert.equal(settings.n, 0, 'the cms_plugin_setting rows survived');
    const triggers = after.prepare("SELECT count(*) AS n FROM cms_trigger_registry WHERE table_name='p_guestbook_note'").get() as { n: number };
    assert.equal(triggers.n, 0, 'the cms_trigger_registry row survived');
  } finally {
    after.close();
  }
  assert.equal(existsSync(join(fixture.dir, 'plugins', 'guestbook')), false, 'the package tree survived the uninstall');

  // A second uninstall is a refusal, not a second success.
  const again = skwctl(['plugin', 'uninstall', 'guestbook', '--tenant', 'acme']);
  assert.equal(again.status, 1, `${again.stderr}\n${again.stdout}`);
  assert.match(again.stderr, /REFUSAL: PLUGIN_REFUSED: SKW_E_PL_UNAVAILABLE: no plugin "guestbook" is installed/);
});
