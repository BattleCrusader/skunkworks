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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';

import { openAdminWrite } from '../app/db/classes.ts';
import { packageRootHash } from '../app/plugins/protocol.ts';
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
  const installed = skwctl(['plugin', 'install', source, '--tenant', 'acme', '--test-report', report, '--runner-digest', 'sha256:cli-test', '--enable']);
  assert.equal(installed.status, 0, `${installed.stderr}\n${installed.stdout}`);
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
  const refused = skwctl(['plugin', 'install', untested, '--tenant', 'acme', '--runner-digest', 'sha256:cli-test', '--enable']);
  assert.equal(refused.status, 1, `${refused.stderr}\n${refused.stdout}`);
  assert.match(refused.stderr, /REFUSAL: PLUGIN_REFUSED: SKW_E_PL_TESTS_STALE: no test report/);
  assert.equal(existsSync(join(fixture.dir, 'plugins', 'untested')), false, 'a refused install copies nothing');
});
