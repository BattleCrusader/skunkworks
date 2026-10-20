/**
 * Installing a package (§8.5, C-9, D27) — the matrix, in the order the SDS states it.
 *
 * There is no publisher CA. What an install proves is:
 *
 *   1. **signature** — a first-party package is verified against the image's key; an
 *      imported one against `data/trust/publishers.json`. An unsigned package is allowed
 *      but is never `first_party`, and the row says `unsigned` (the install screen is the
 *      trust decision, §8.5).
 *   2. **revocation** — `cms_plugin_revoked` names a package root; that root cannot be
 *      installed or enabled whatever it says about itself.
 *   3. **the test report** — `{plugin, version, root_hash, runner_image_digest, ran_at}`,
 *      written by the packager's run inside the runner image. Missing, for another root,
 *      or for another image digest is `SKW_E_PL_TESTS_STALE`: a plugin cannot ship
 *      untested and be discovered by a client's contact form.
 *   4. **schema range, export class, migration grammar** — `SKW_E_PL_SCHEMA`,
 *      `SKW_E_PL_NO_EXPORT_CLASS`, `SKW_E_PL_DESTRUCTIVE_UPGRADE`.
 *
 * Only then does anything write: one transaction creates the declared tables (and the
 * `asset_key` guards with them), registers them, writes the migration ledger row, and
 * inserts `cms_plugin_installed`. The package is copied before the transaction and the
 * copy is removed if the transaction refuses, so a refused install leaves no code.
 */
import { createHash, verify as verifySignature } from 'node:crypto';
import Database from 'better-sqlite3';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from '../errors.ts';
import { openAdminWrite } from '../db/classes.ts';
import {
  packageDir,
  packageRootHash,
  parseManifest,
  readManifest,
  tableStatements,
  type Manifest,
} from './protocol.ts';

export interface TestReport {
  plugin: string;
  version: string;
  root_hash: string;
  runner_image_digest: string;
  ran_at: string;
}

export interface InstallRequest {
  /** The tenant's `site.db`. */
  siteDb: string;
  /** `<data>/plugins` — where compose mounts `/srv/plugins:ro`. */
  pluginsRoot: string;
  /** The package directory to install. */
  sourceDir: string;
  /** `test-report.json` from the packager. Absent is a refusal, not a warning. */
  testReportPath?: string;
  /** The digest of the runner image that will run it; a report for another image is stale. */
  runnerImageDigest?: string;
  /** The digest the report claims, read back by the gate. */
  publisher?: string;
  signatureState?: 'first_party' | 'imported' | 'unsigned';
  /** SPKI PEM public keys trusted for `first_party` / `imported`. */
  firstPartyKeys?: string[];
  publisherKeys?: { fingerprint: string; spki: string }[];
  /** Base64 Ed25519 signature over the package root hash (hex). */
  signature?: string;
  enable?: boolean;
  now?: string;
}

export interface InstallResult {
  plugin: string;
  version: string;
  root_hash: string;
  test_report_sha: string;
  enabled: boolean;
  tables: string[];
  capabilities: string[];
  package_dir: string;
}

function refuse(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new AppError(code, message, detail ?? {});
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A report for another package or another image is stale; there is no "close enough". */
export function readTestReport(path: string, root: string, digest: string): { sha: string; report: TestReport } {
  if (!existsSync(path)) {
    refuse('SKW_E_PL_TESTS_STALE', `no test report: the packager must run plugin.json.tests inside the runner image (${path})`, {
      expected_runner_image_digest: digest,
    });
  }
  const bytes = readFileSync(path);
  let report: TestReport;
  try {
    report = JSON.parse(bytes.toString('utf8')) as TestReport;
  } catch (err) {
    refuse('SKW_E_PL_TESTS_STALE', `the test report is not JSON: ${String(err)}`);
  }
  if (typeof report.root_hash !== 'string' || report.root_hash !== root) {
    refuse('SKW_E_PL_TESTS_STALE', 'the test report is for a different package root — the bytes changed after the test run', {
      report_root_hash: report.root_hash ?? null,
      package_root_hash: root,
    });
  }
  if (report.runner_image_digest !== digest) {
    refuse('SKW_E_PL_TESTS_STALE', 'the test report was produced by another runner image', {
      report_runner_image_digest: report.runner_image_digest ?? null,
      runner_image_digest: digest,
    });
  }
  return { sha: sha256(bytes), report };
}

function verifyPackageSignature(input: InstallRequest, root: string): { state: 'first_party' | 'imported' | 'unsigned'; fingerprint: string | null } {
  const state = input.signatureState ?? 'unsigned';
  if (state === 'unsigned') return { state, fingerprint: null };
  if (typeof input.signature !== 'string' || input.signature === '') {
    refuse('SKW_E_PL_SIGNATURE', `signature_state=${state} but the install carries no signature`);
  }
  const spki = state === 'first_party' ? (input.firstPartyKeys ?? []) : (input.publisherKeys ?? []).map((k) => k.spki);
  if (spki.length === 0) {
    refuse('SKW_E_PL_SIGNATURE', state === 'first_party' ? 'no first-party key in this image' : 'no publisher key was imported for this install');
  }
  const signature = Buffer.from(input.signature, 'base64');
  const signed = Buffer.from(root, 'utf8');
  for (const pem of spki) {
    try {
      if (verifySignature(null, signed, pem, signature)) {
        const fingerprint = sha256(Buffer.from(pem));
        return { state, fingerprint: (state === 'imported' ? input.publisherKeys?.find((k) => k.spki === pem)?.fingerprint : undefined) ?? fingerprint };
      }
    } catch {
      /* the next key; a malformed key is not a valid signature */
    }
  }
  refuse('SKW_E_PL_SIGNATURE', `the signature does not verify against any ${state} key for root ${root}`);
}

/**
 * Install one package into one tenant. Idempotent when the same root is installed again;
 * a different root under the same id is refused (uninstall first, §8.2's only downgrade
 * path), because two roots for one id would make `cms_plugin_installed` a lie.
 */
export function installPlugin(input: InstallRequest): InstallResult {
  const source = readManifest(input.sourceDir);
  const { root, files } = packageRootHash(input.sourceDir);
  const digest = input.runnerImageDigest ?? process.env.SKW_RUNNER_IMAGE_DIGEST ?? 'dev';
  const db = openAdminWrite(input.siteDb, 5000);
  try {
    const revoked = db.prepare('SELECT plugin_id, reason FROM cms_plugin_revoked WHERE root_hash = ?').get(root) as
      | { plugin_id: string; reason: string | null }
      | undefined;
    if (revoked !== undefined) {
      refuse('SKW_E_PL_REVOKED', `package root ${root} is revoked on this install`, { plugin: revoked.plugin_id, reason: revoked.reason });
    }
    const signature = verifyPackageSignature(input, root);

    // §8.5's order: signature, revocation, test report, schema, export class, migration.
    const report = readTestReport(input.testReportPath ?? join(input.sourceDir, 'test-report.json'), root, digest);

    const siteVersion = Number(db.pragma('user_version', { simple: true }));
    if (source.requires?.site_db_min !== undefined && siteVersion < source.requires.site_db_min) {
      refuse('SKW_E_PL_SCHEMA', `${source.id} needs site.db >= ${source.requires.site_db_min}; this tenant is ${siteVersion}`);
    }
    if (source.requires?.site_db_max !== undefined && siteVersion > source.requires.site_db_max) {
      refuse('SKW_E_PL_SCHEMA', `${source.id} supports site.db <= ${source.requires.site_db_max}; this tenant is ${siteVersion}`);
    }
    for (const table of source.tables) {
      if (!['rows', 'empty', 'filtered', 'secret'].includes(table.export)) {
        refuse('SKW_E_PL_NO_EXPORT_CLASS', `${source.id}: table ${table.name} has no export class`);
      }
    }

    const existing = db.prepare('SELECT root_hash, enabled FROM cms_plugin_installed WHERE plugin_id = ?').get(source.id) as
      | { root_hash: string; enabled: number }
      | undefined;
    const target = packageDir(input.pluginsRoot, source.id);
    if (existing !== undefined && existing.root_hash !== root) {
      refuse('SKW_E_PL_SCHEMA', `${source.id} is installed at root ${existing.root_hash}; uninstall it before installing ${root}`, {
        installed_root_hash: existing.root_hash,
        package_root_hash: root,
      });
    }

    // Copy first, transaction second. `cpSync` into a sibling then rename is atomic on the
    // same filesystem; a copy into the live directory would expose a half package.
    if (!existsSync(target)) {
      mkdirSync(input.pluginsRoot, { recursive: true });
      const staging = `${target}.tmp-${process.pid}`;
      rmSync(staging, { recursive: true, force: true });
      cpSync(input.sourceDir, staging, { recursive: true });
      renameSync(staging, target);
    }

    const enabled = input.enable === true;
    if (enabled && report.sha === '') refuse('SKW_E_PL_TESTS_STALE', 'a plugin cannot be enabled without a test report');
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const statement of tableStatements(source)) db.exec(statement);
      for (const table of source.tables) {
        const columns = table.columns ?? [];
        const indexCount = columns.filter((c) => c.indexed === true).length;
        db.prepare(
          `INSERT INTO cms_table_registry (table_name, table_class, plugin_id, ddl_version, column_count, index_count, columns_json)
           VALUES (?, 'plugin', ?, 1, ?, ?, ?)
           ON CONFLICT(table_name) DO UPDATE SET column_count = excluded.column_count, index_count = excluded.index_count, columns_json = excluded.columns_json`,
        ).run(
          table.name,
          source.id,
          columns.length + 1,
          indexCount,
          JSON.stringify([{ name: 'id', type: 'INTEGER', notNull: true, pk: true }, ...columns]),
        );
      }
      db.prepare(
        `INSERT INTO cms_plugin_migration (plugin_id, version, seq, checksum) VALUES (?, ?, 1, ?)
         ON CONFLICT(plugin_id, version, seq) DO UPDATE SET checksum = excluded.checksum`,
      ).run(source.id, source.version, sha256(JSON.stringify(files)));
      db.prepare(
        `INSERT INTO cms_plugin_installed
           (plugin_id, version, manifest_json, root_hash, publisher, publisher_key_fingerprint,
            signature_state, enabled, test_report_sha, runner_image_digest, enabled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET
           version = excluded.version, manifest_json = excluded.manifest_json, root_hash = excluded.root_hash,
           publisher = excluded.publisher, publisher_key_fingerprint = excluded.publisher_key_fingerprint,
           signature_state = excluded.signature_state, enabled = excluded.enabled,
           test_report_sha = excluded.test_report_sha, runner_image_digest = excluded.runner_image_digest,
           enabled_at = excluded.enabled_at`,
      ).run(
        source.id,
        source.version,
        JSON.stringify(source),
        root,
        input.publisher ?? signature.state,
        signature.fingerprint,
        signature.state,
        enabled ? 1 : 0,
        report.sha,
        digest,
        enabled ? (input.now ?? new Date().toISOString()) : null,
      );
      db.exec('COMMIT');
    } catch (err) {
      if (db.inTransaction) db.exec('ROLLBACK');
      if (existing === undefined) rmSync(target, { recursive: true, force: true });
      throw err;
    }

    return {
      plugin: source.id,
      version: source.version,
      root_hash: root,
      test_report_sha: report.sha,
      enabled,
      tables: source.tables.map((t) => t.name),
      capabilities: source.capabilities,
      package_dir: target,
    };
  } finally {
    db.close();
  }
}

/** The row, without the manifest body — what a gate and the export compare. */
export interface InstalledPlugin {
  /** `cms_plugin_installed.id` — what an operator sees in a refusal. */
  id: number;
  plugin_id: string;
  version: string;
  root_hash: string;
  manifest: Manifest;
  test_report_sha: string | null;
  runner_image_digest: string | null;
  enabled: boolean;
  signature_state: string;
}

export function installedPlugins(db: Database.Database): InstalledPlugin[] {
  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_installed'`).get();
  if (table === undefined) return [];
  const rows = db
    .prepare(
      `SELECT id, plugin_id, version, root_hash, manifest_json, test_report_sha, runner_image_digest, enabled, signature_state
       FROM cms_plugin_installed ORDER BY id`,
    )
    .all() as {
    id: number;
    plugin_id: string;
    version: string;
    root_hash: string;
    manifest_json: string;
    test_report_sha: string | null;
    runner_image_digest: string | null;
    enabled: number;
    signature_state: string;
  }[];
  return rows.map((row) => ({
    id: Number(row.id),
    plugin_id: String(row.plugin_id),
    version: String(row.version),
    root_hash: String(row.root_hash),
    manifest: parseManifest(JSON.parse(row.manifest_json) as unknown),
    test_report_sha: row.test_report_sha,
    runner_image_digest: row.runner_image_digest,
    enabled: row.enabled === 1,
    signature_state: String(row.signature_state),
  }));
}

export function assertEnabled(db: Database.Database, plugin: string): InstalledPlugin {
  const row = installedPlugins(db).find((p) => p.plugin_id === plugin);
  if (row === undefined) {
    throw new AppError('SKW_E_PL_UNAVAILABLE', `no plugin ${JSON.stringify(plugin)} is installed for this tenant`, { plugin });
  }
  if (!row.enabled) {
    throw new AppError('SKW_E_PL_UNAVAILABLE', `plugin ${plugin} is installed but not enabled`, { plugin });
  }
  if (row.test_report_sha === null) {
    // The row CHECK already forbids it; this is the reader's half, so a hand-edited row
    // (or `PRAGMA ignore_check_constraints`) is still not grantable.
    throw new AppError('SKW_E_PL_TESTS_STALE', `plugin ${plugin} has no test report and cannot be granted`, { plugin });
  }
  return row;
}
