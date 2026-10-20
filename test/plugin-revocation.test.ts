/**
 * Revocation, and what an unsigned package may call itself — two retained-scope blockers,
 * measured under the in-process model (`S5` items 5a and 5b).
 *
 * **5a — revocation was a silent no-op.** As shipped, writing `data/trust/revoked.json` for a
 * root and installing that exact root exited 0 and installed: the install read
 * `cms_plugin_revoked` only, and nothing but a test ever wrote *that* table either. §8.5 names
 * the file as the install's record, so the file was a second source of truth with no reader.
 * Under D36 there is a second moment that matters: **enable** is when a module is `import()`ed
 * and its code starts running, so a root revoked after install must be stoppable without an
 * uninstall. `V1`–`V4` prove both moments, by name.
 *
 * **5b — an unsigned package could self-declare a trusted publisher.** It landed in
 * `cms_plugin_installed` and in the audit chain as `publisher=acme-labs` with a null
 * fingerprint. `V5` proves the claim is quarantined: the row says `unsigned`, the screen shows
 * the claim as rejected, and the audit row cannot be made to say otherwise.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { installPlugin, inspectPackage } from '../app/plugins/install.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { PluginRuntime } from '../app/plugins/runtime.ts';
import { REVOCATION_FORMAT, readRevocationFile, revocationPath } from '../app/plugins/revocation.ts';
import { trustDirFor } from '../app/plugins/trust.ts';
import { REPO, SCHEMA } from './helpers/fixture.ts';

const TENANT = 'acme';
const DIGEST = 'sha256:s5-revoke-app';
const CLAIMANT = join(REPO, 'test', 'fixtures', 'plugins', 'claimant');
const NOTES = join(REPO, 'test', 'fixtures', 'plugins', 'notes');

let dir = '';
let siteDb = '';
let trustDir = '';

function makeSite(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new Database(path);
  db.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
  db.close();
}

function report(sourceDir: string, id: string, version = '1.0.0'): string {
  const { root } = packageRootHash(sourceDir);
  const path = join(dir, `${id}-${root.slice(0, 8)}-report.json`);
  writeFileSync(path, `${JSON.stringify({ plugin: id, version, root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`);
  return path;
}

/** Write the revocation **file** — the thing that used to be read by nobody. */
function writeFileOnly(root: string, pluginId: string, reason = 'measured in the S5 QA'): void {
  mkdirSync(trustDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    revocationPath(trustDir),
    `${JSON.stringify({ format: REVOCATION_FORMAT, revoked: [{ root_hash: root, plugin_id: pluginId, reason, revoked_at: new Date().toISOString() }] }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function clearRevocations(): void {
  rmSync(revocationPath(trustDir), { force: true });
  const db = openAdminWrite(siteDb, 5000);
  try {
    db.prepare('DELETE FROM cms_plugin_revoked').run();
  } finally {
    db.close();
  }
}

function skwctl(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['app/cli/skwctl.ts', ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      SKW_DATA_DIR: dir,
      SKW_EDGE_TOKEN: 'test-edge-token-0123456789abcdef',
      SKW_SESSION_KEY: 'test-session-key-0123456789abcdef',
      SKW_DOWNLOAD_TOKEN_KEY: 'test-download-key-0123456789abcdef',
      SKW_IP_HASH_KEY: 'test-ip-hash-key-0123456789abcdef',
      SKW_ADMIN_ORIGIN: 'https://admin.skw.test',
      SKW_BUILD_ID: 'test-build',
      SKW_ARGON2_MAX_CONCURRENT: '4',
      SKW_BOX_RPS: '192',
      UV_THREADPOOL_SIZE: '8',
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'skw-s5-revoke-'));
  siteDb = join(dir, 'tenants', TENANT, 'site.db');
  makeSite(siteDb);
  trustDir = trustDirFor(siteDb);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ 5a, moment 1: INSTALL

test('V1 — a root named only in data/trust/revoked.json is refused at install, by name and by source', () => {
  clearRevocations();
  const { root } = packageRootHash(CLAIMANT);
  writeFileOnly(root, 'claimant');

  // Exit 0 and an installed row is exactly what the QA measured; the assertion is the opposite.
  const run = skwctl(['plugin', 'install', CLAIMANT, '--tenant', TENANT, '--allow-unsigned']);
  assert.equal(run.status, 1, `install of a revoked root must exit 1, not 0.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.match(run.stderr, /SKW_E_PL_REVOKED/, 'the refusal names the code');
  assert.match(run.stderr, /revoked on this install \(file/, 'the refusal names which source said so');
  assert.match(run.stderr, /claimant/, 'the refusal names the package');

  const db = openAdminWrite(siteDb, 5000);
  try {
    const row = db.prepare('SELECT plugin_id FROM cms_plugin_installed WHERE plugin_id = ?').get('claimant');
    assert.equal(row, undefined, 'nothing was installed by a refusal');
  } finally {
    db.close();
  }
});

test('V1b — the same package with the same report installs once the file entry is gone (positive control)', () => {
  clearRevocations();
  const result = installPlugin({
    siteDb,
    pluginsRoot: join(dir, 'plugins'),
    sourceDir: CLAIMANT,
    allowUnsigned: true,
    testReportPath: report(CLAIMANT, 'claimant'),
    runnerImageDigest: DIGEST,
  });
  assert.equal(result.plugin, 'claimant');
  assert.equal(result.unsigned, true);
  // …and a root in the **table** is refused too, so neither source is decorative.
  const db = openAdminWrite(siteDb, 5000);
  try {
    db.prepare('INSERT INTO cms_plugin_revoked (root_hash, plugin_id, reason) VALUES (?, ?, ?)').run(
      'f'.repeat(64),
      'other',
      'a different root: must not affect this one',
    );
    db.prepare('INSERT INTO cms_plugin_revoked (root_hash, plugin_id, reason) VALUES (?, ?, ?)').run(
      packageRootHash(CLAIMANT).root,
      'claimant',
      'revoked in the tenant table',
    );
  } finally {
    db.close();
  }
  assert.throws(
    () =>
      inspectPackage({
        siteDb,
        pluginsRoot: join(dir, 'plugins'),
        sourceDir: CLAIMANT,
        allowUnsigned: true,
        testReportPath: report(CLAIMANT, 'claimant'),
        runnerImageDigest: DIGEST,
      }),
    (err: unknown) => (err as { code?: string }).code === 'SKW_E_PL_REVOKED',
    'a root in cms_plugin_revoked refuses the install as well',
  );
  clearRevocations();
});

// ------------------------------------------------------------------ 5a, moment 2: ENABLE

test('V2 — a root revoked after install is refused at ENABLE, without an uninstall', async () => {
  clearRevocations();
  // Installed while trusted…
  const result = installPlugin({
    siteDb,
    pluginsRoot: join(dir, 'plugins'),
    sourceDir: NOTES,
    allowUnsigned: true,
    testReportPath: report(NOTES, 'notes'),
    runnerImageDigest: DIGEST,
  });
  assert.equal(result.enabled, false);
  // …then revoked. Only the file: the operator wrote the thing §8.5 names.
  writeFileOnly(packageRootHash(NOTES).root, 'notes', 'pulled after a report');

  const runtime = new PluginRuntime({ dataDir: dir, emailMode: 'off' });
  let caught: unknown = null;
  try {
    await runtime.enable(TENANT, 'notes');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, 'enable must refuse, not return a happy result');
  assert.equal((caught as { code?: string }).code, 'SKW_E_PL_REVOKED', `expected SKW_E_PL_REVOKED, got ${String(caught)}`);
  assert.match((caught as Error).message, /notes/, 'the refusal names the package');
  assert.match((caught as Error).message, /\(file/, 'the refusal names the source');
  assert.equal(runtime.registry.has(TENANT, 'notes'), false, 'no module was registered: the import never happened');

  const db = openAdminWrite(siteDb, 5000);
  try {
    const row = db.prepare('SELECT enabled FROM cms_plugin_installed WHERE plugin_id = ?').get('notes') as { enabled: number };
    assert.equal(row.enabled, 0, 'the row is not enabled');
    // The package is still installed — revocation stopped the code without destroying data.
    assert.ok(db.prepare('SELECT root_hash FROM cms_plugin_installed WHERE plugin_id = ?').get('notes') !== undefined);
  } finally {
    db.close();
  }
  clearRevocations();
});

test('V3 — skwctl plugin revoke writes BOTH sources, audits, and disables a running package', () => {
  clearRevocations();
  const { root } = packageRootHash(NOTES);
  const run = skwctl(['plugin', 'revoke', 'notes', '--tenant', TENANT, '--reason', 'S5 proof']);
  assert.equal(run.status, 0, `revoke failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /plugin: revoked id=notes/);
  assert.match(run.stdout, /table=written file=written/);

  // The file…
  const file = readRevocationFile(trustDir);
  assert.equal(file.length, 1, 'the file carries the root');
  assert.equal(file[0]?.root_hash, root);
  assert.equal(file[0]?.reason, 'S5 proof');
  // …the table…
  const db = openAdminWrite(siteDb, 5000);
  try {
    const row = db.prepare('SELECT reason FROM cms_plugin_revoked WHERE root_hash = ?').get(root) as { reason: string } | undefined;
    assert.equal(row?.reason, 'S5 proof');
    // …and the audit chain, with both writes recorded.
    const audit = db
      .prepare(`SELECT before_json, after_json FROM cms_audit WHERE action = 'plugin.revoke' ORDER BY id DESC LIMIT 1`)
      .get() as { after_json: string } | undefined;
    assert.ok(audit !== undefined, 'the revoke is audited');
    const detail = JSON.parse(audit.after_json) as Record<string, unknown>;
    assert.equal(detail['plugin'], 'notes');
    assert.equal(detail['table_written'], true);
    assert.equal(detail['file_written'], true);
  } finally {
    db.close();
  }

  // A second revoke is idempotent, not a rewrite.
  const again = skwctl(['plugin', 'revoke', 'notes', '--tenant', TENANT]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /table=already present file=already present/);

  // And the enable that follows is refused by name.
  const enable = skwctl(['plugin', 'enable', 'notes', '--tenant', TENANT]);
  assert.equal(enable.status, 1, `enable of a revoked root must exit 1:\n${enable.stdout}`);
  assert.match(enable.stderr, /SKW_E_PL_REVOKED/, 'the CLI refusal carries the code');
  clearRevocations();
});

// ------------------------------------------------------------------ 5b: the publisher claim

test('V4 — an unsigned package cannot make itself a publisher; the claim is quarantined', () => {
  clearRevocations();
  const inspected = inspectPackage({
    siteDb,
    pluginsRoot: join(dir, 'plugins'),
    sourceDir: CLAIMANT,
    allowUnsigned: true,
    testReportPath: report(CLAIMANT, 'claimant'),
    runnerImageDigest: DIGEST,
  });
  // The manifest does claim a publisher. Nothing signed it.
  assert.equal(inspected.manifest.publisher?.id, 'acme-labs');
  assert.equal(inspected.verified.state, 'unsigned');
  assert.equal(inspected.verified.publisher, 'unsigned', 'an unsigned package has no publisher');
  assert.equal(inspected.verified.fingerprint, null);
  assert.equal(inspected.verified.claimed_publisher, 'acme-labs', 'the claim is kept where it can be seen');
  assert.equal(inspected.screen.publisher, 'unsigned', 'the screen a human decides on does not carry the claimed name');
  assert.equal(inspected.screen.claimed_publisher, 'acme-labs');

  // The row, written by the CLI so the audit chain is the real one.
  const run = skwctl([
    'plugin',
    'install',
    CLAIMANT,
    '--tenant',
    TENANT,
    '--allow-unsigned',
    '--test-report',
    report(CLAIMANT, 'claimant'),
    '--runner-digest',
    DIGEST,
  ]);
  assert.equal(run.status, 0, `install failed:\n${run.stdout}\n${run.stderr}`);

  const db = openAdminWrite(siteDb, 5000);
  try {
    const row = db
      .prepare('SELECT publisher, publisher_key_fingerprint, signature_state FROM cms_plugin_installed WHERE plugin_id = ?')
      .get('claimant') as { publisher: string; publisher_key_fingerprint: string | null; signature_state: string };
    assert.equal(row.publisher, 'unsigned', 'the row records unsigned, never the claimed name');
    assert.equal(row.publisher_key_fingerprint, null);
    assert.equal(row.signature_state, 'unsigned');

    // The audit row is the one an incident review reads. It may say `unsigned`; it may not say
    // `acme-labs` anywhere a reader would take for a publisher.
    const audit = db
      .prepare(`SELECT after_json FROM cms_audit WHERE action = 'plugin.install' AND target_id = 'claimant' ORDER BY id DESC LIMIT 1`)
      .get() as { after_json: string } | undefined;
    assert.ok(audit !== undefined, 'the install is audited');
    const detail = JSON.parse(audit.after_json) as Record<string, unknown>;
    assert.equal(detail['publisher'], 'unsigned', 'the audit row cannot be made to say acme-labs');
    assert.equal(detail['allow_unsigned'], true, 'and it records that the unsigned flag was passed');

    // Structural: no row anywhere in the tenant database has this package as a *signed*
    // publisher, and no row names acme-labs beside a null fingerprint.
    const offenders = db
      .prepare(
        `SELECT plugin_id FROM cms_plugin_installed
         WHERE signature_state = 'unsigned' AND publisher <> 'unsigned'`,
      )
      .all() as { plugin_id: string }[];
    assert.deepEqual(offenders, [], 'no unsigned row may carry a publisher name');
  } finally {
    db.close();
  }
});
