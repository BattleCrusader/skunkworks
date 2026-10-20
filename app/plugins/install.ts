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
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AppError } from '../errors.ts';
import { openAdminWrite } from '../db/classes.ts';
import {
  PLUGIN_TABLE,
  isDirectory,
  packageDir,
  packageRootHash,
  parseManifest,
  readManifest,
  tableStatements,
  type Manifest,
} from './protocol.ts';
import {
  installScreen,
  trustDirFor,
  verifyPackageSignature,
  type InstallScreen,
  type SignatureState,
  type VerifiedPackage,
} from './trust.ts';

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
  /**
   * §8.5/D27: the detached `plugin.sig.json`. Absent means the package offers no
   * signature — legal only with `allowUnsigned`, and never `first_party`.
   */
  signaturePath?: string;
  /**
   * The loud flag. Without it an unsigned package is `SKW_E_PL_SIGNATURE`; with it the
   * install prints what it is doing and the audit row records that it was passed.
   */
  allowUnsigned?: boolean;
  /** `<data>/trust`; defaults to the install beside this tenant's database. */
  trustDir?: string;
  /** The image's key, overridable only by a gate. Production passes nothing. */
  firstPartyKeys?: string[];
  /** `test-report.json` from the packager. Absent is a refusal, not a warning. */
  testReportPath?: string;
  /** The digest of the runner image that will run it; a report for another image is stale. */
  runnerImageDigest?: string;
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
  signature_state: SignatureState;
  publisher: string;
  publisher_key_fingerprint: string | null;
  /** True only when `allowUnsigned` was passed — the audit row repeats it. */
  unsigned: boolean;
  /** §8.5's screen: what an operator decides on, and what the CLI prints before enable. */
  screen: InstallScreen;
}

export interface InspectedPackage {
  root_hash: string;
  test_report_sha: string;
  verified: VerifiedPackage;
  screen: InstallScreen;
  manifest: Manifest;
}


function refuse(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new AppError(code, message, detail ?? {});
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A **synchronous** pause. `better-sqlite3` is synchronous, so an `await setTimeout` is not
 * available at this point in the uninstall and a child process would be absurd for 20 ms.
 */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 25 × 20 ms: a request in the other process is finishing, not holding the WAL for a second. */
const CHECKPOINT_ATTEMPTS = 25;
const CHECKPOINT_PAUSE_MS = 20;

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

/**
 * §8.5's matrix, in the order the SDS states it: **signature, revocation, test report,
 * schema range, export class, migration**. Nothing is written here.
 *
 * This is the function the install screen is built from, and `installPlugin()` runs it
 * again immediately before writing — so the screen an operator reads describes the bytes
 * that are about to be installed, not bytes that were there when the screen was printed.
 */
export function inspectPackage(input: InstallRequest): InspectedPackage {
  const source = readManifest(input.sourceDir);
  const { root } = packageRootHash(input.sourceDir);
  const digest = input.runnerImageDigest ?? process.env.SKW_RUNNER_IMAGE_DIGEST ?? 'dev';

  // 1. signature (D27). An unsigned package is a refusal unless the operator said so, and
  //    saying so is recorded, never inferred.
  const verified = verifyPackageSignature({
    dir: input.sourceDir,
    ...(input.signaturePath === undefined ? {} : { signaturePath: input.signaturePath }),
    trustDir: input.trustDir ?? trustDirFor(input.siteDb),
    ...(input.firstPartyKeys === undefined ? {} : { firstPartyKeys: input.firstPartyKeys }),
    manifest: source,
  });
  if (verified.state === 'unsigned' && input.allowUnsigned !== true) {
    // A package that ships a signature beside it and an operator who forgot the flag is the
    // one case where "pass --allow-unsigned" is the wrong next step: say that the signature is
    // there, so the flag is chosen deliberately rather than as the shortest way past a refusal.
    const hint = [join(input.sourceDir, 'plugin.sig.json'), join(input.sourceDir, '..', `${source.id}-${source.version}.sig.json`)].find(
      (candidate) => existsSync(candidate),
    );
    refuse(
      'SKW_E_PL_SIGNATURE',
      hint === undefined
        ? `${source.id} is not signed by any key this install trusts; pass --allow-unsigned to install it anyway (the install is audited as unsigned)`
        : `${source.id} offers no signature; one is present at ${hint} — pass --signature ${hint} (or --allow-unsigned to install unsigned code deliberately)`,
      { plugin: source.id, reason: 'unsigned', flag: '--allow-unsigned', signature_present: hint ?? null },
    );
  }

  const db = openAdminWrite(input.siteDb, 5000);
  try {
    // 2. revocation.
    const revoked = db.prepare('SELECT plugin_id, reason FROM cms_plugin_revoked WHERE root_hash = ?').get(root) as
      | { plugin_id: string; reason: string | null }
      | undefined;
    if (revoked !== undefined) {
      refuse('SKW_E_PL_REVOKED', `package root ${root} is revoked on this install`, { plugin: revoked.plugin_id, reason: revoked.reason });
    }

    // 3. the test report.
    const report = readTestReport(input.testReportPath ?? join(input.sourceDir, 'test-report.json'), root, digest);

    // 4. schema range.
    const siteVersion = Number(db.pragma('user_version', { simple: true }));
    if (source.requires?.site_db_min !== undefined && siteVersion < source.requires.site_db_min) {
      refuse('SKW_E_PL_SCHEMA', `${source.id} needs site.db >= ${source.requires.site_db_min}; this tenant is ${siteVersion}`);
    }
    if (source.requires?.site_db_max !== undefined && siteVersion > source.requires.site_db_max) {
      refuse('SKW_E_PL_SCHEMA', `${source.id} supports site.db <= ${source.requires.site_db_max}; this tenant is ${siteVersion}`);
    }

    // 5. export class.
    for (const table of source.tables) {
      if (!['rows', 'empty', 'filtered', 'secret'].includes(table.export)) {
        refuse('SKW_E_PL_NO_EXPORT_CLASS', `${source.id}: table ${table.name} has no export class`);
      }
    }

    // 6. the downgrade path: a different root under the same id is uninstall-first (§8.2).
    const existing = db.prepare('SELECT root_hash, enabled FROM cms_plugin_installed WHERE plugin_id = ?').get(source.id) as
      | { root_hash: string; enabled: number }
      | undefined;
    if (existing !== undefined && existing.root_hash !== root) {
      refuse('SKW_E_PL_SCHEMA', `${source.id} is installed at root ${existing.root_hash}; uninstall it before installing ${root}`, {
        installed_root_hash: existing.root_hash,
        package_root_hash: root,
      });
    }

    const screen = installScreen({
      manifest: source,
      verified,
      root,
      report: { sha256: report.sha, ran_at: report.report.ran_at, runner_image_digest: report.report.runner_image_digest },
    });
    return { root_hash: root, test_report_sha: report.sha, verified, screen, manifest: source };
  } finally {
    db.close();
  }
}

/**
 * Install one package into one tenant. Idempotent when the same root is installed again;
 * a different root under the same id is refused (uninstall first, §8.2's only downgrade
 * path), because two roots for one id would make `cms_plugin_installed` a lie.
 */
export function installPlugin(input: InstallRequest): InstallResult {
  const inspected = inspectPackage(input);
  const source = inspected.manifest;
  const { root, files } = packageRootHash(input.sourceDir);
  if (root !== inspected.root_hash) {
    // The screen was built from other bytes. Refusing is the only honest answer: an
    // operator who approved a screen approved a package, not a directory.
    refuse('SKW_E_PL_SIGNATURE', `the package changed while it was being installed (${inspected.root_hash} → ${root})`, {
      screened_root_hash: inspected.root_hash,
      package_root_hash: root,
    });
  }
  const digest = input.runnerImageDigest ?? process.env.SKW_RUNNER_IMAGE_DIGEST ?? 'dev';
  const verified = inspected.verified;
  const report = { sha: inspected.test_report_sha };
  const db = openAdminWrite(input.siteDb, 5000);
  try {
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
        verified.publisher,
        verified.fingerprint,
        verified.state,
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
      signature_state: verified.state,
      publisher: verified.publisher,
      publisher_key_fingerprint: verified.fingerprint,
      unsigned: verified.state === 'unsigned',
      screen: inspected.screen,
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

/**
 * Uninstall (§8.2, §8.6, F15) — the operator path that did not exist before S4e.
 *
 * §8.2 specified a **whole-file** `VACUUM INTO` archive first, then the plugin's rows and
 * tables dropped, and named the consequence: restoring that archive rolls back every other
 * change made since (O-40 DEFERRED, "a table-scoped format is a v2 experiment"). This is the
 * table-scoped format, delivered: the archive holds only the rows, settings, registry and
 * migration rows that belong to this package, so restoring it cannot resurrect a page
 * somebody edited last Tuesday. A restore is therefore a real (if manual) v2 operation
 * rather than an all-or-nothing file swap.
 *
 * Order, and why:
 *   1. read the package's declared tables **from the installed manifest** and re-validate
 *      every name against the plugin grammar — a hand-edited `manifest_json` must not be
 *      able to make `DROP TABLE` name a core table;
 *   2. write the archive atomically (tmp + rename, 0600: it is the tenant's data);
 *   3. one transaction drops the asset-guard triggers, then the tables, then the registry,
 *      migration, setting and installed rows. Triggers first: a guard trigger lives on
 *      `cms_asset` and names the plugin table in its WHEN clause, so dropping the table
 *      first would leave `cms_asset` deletes raising "no such table";
 *   4. only after COMMIT, remove `<data>/plugins/<id>`.
 *
 * A package that is not installed is a refusal (`SKW_E_PL_UNAVAILABLE`), not a silent
 * success: an operator who mistypes an id must not be told the box is clean.
 */
export interface UninstallRequest {
  /** The tenant's `site.db`. */
  siteDb: string;
  /** `<data>/plugins`. */
  pluginsRoot: string;
  pluginId: string;
  /** `<data>/plugin-archive` by default; created 0700 if absent. */
  archiveDir?: string;
  now?: string;
}

export interface UninstallResult {
  plugin: string;
  version: string;
  root_hash: string;
  archive_path: string;
  tables: { name: string; rows: number }[];
  settings: number;
  package_removed: boolean;
}

export function uninstallPlugin(input: UninstallRequest): UninstallResult {
  const db = openAdminWrite(input.siteDb, 5000);
  try {
    const row = installedPlugins(db).find((p) => p.plugin_id === input.pluginId);
    if (row === undefined) {
      throw new AppError('SKW_E_PL_UNAVAILABLE', `no plugin ${JSON.stringify(input.pluginId)} is installed for this tenant`, {
        plugin: input.pluginId,
      });
    }
    // The manifest is the row's own claim. Re-validate every table name against the frozen
    // grammar and the package's namespace before it can reach a DROP.
    for (const table of row.manifest.tables) {
      const match = PLUGIN_TABLE.exec(table.name);
      if (match === null || match[1] !== row.plugin_id) {
        throw new AppError('SKW_E_PL_NO_EXPORT_CLASS', `refusing to drop ${JSON.stringify(table.name)}: it is not a table of ${row.plugin_id}`, {
          plugin: row.plugin_id,
          table: table.name,
        });
      }
    }

    const now = input.now ?? new Date().toISOString();
    const archiveDir = input.archiveDir ?? join(dirname(input.siteDb), '..', '..', 'plugin-archive');
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const stamp = now.replace(/[:.]/g, '-');
    const archivePath = join(archiveDir, `${row.plugin_id}-${row.version}-${stamp}.json`);

    const tables: { name: string; rows: Record<string, unknown>[] }[] = [];
    for (const table of row.manifest.tables) {
      const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table.name);
      tables.push({ name: table.name, rows: exists === undefined ? [] : (db.prepare(`SELECT * FROM "${table.name}"`).all() as Record<string, unknown>[]) });
    }
    // §8.3: a `secret` setting is write-only. The archive records that the key existed and
    // never its value — an archive an operator can read must not become the one place a
    // secret is stored in the clear.
    const settings = db
      .prepare('SELECT key, value_json, type, secret FROM cms_plugin_setting WHERE plugin_id = ? ORDER BY key')
      .all(row.plugin_id) as { key: string; value_json: string; type: string; secret: number }[];
    const registry = db.prepare('SELECT * FROM cms_table_registry WHERE plugin_id = ?').all(row.plugin_id);
    const migrations = db.prepare('SELECT * FROM cms_plugin_migration WHERE plugin_id = ?').all(row.plugin_id);
    const triggers = db
      .prepare(`SELECT * FROM cms_trigger_registry WHERE table_name IN (${tables.map(() => '?').join(',') || 'NULL'})`)
      .all(...tables.map((t) => t.name));

    const archive = {
      format: 'skw-plugin-archive/1',
      plugin: row.plugin_id,
      version: row.version,
      root_hash: row.root_hash,
      uninstalled_at: now,
      tables: tables.map((t) => ({ name: t.name, rows: t.rows })),
      settings: settings.map((s) => ({ key: s.key, type: s.type, secret: s.secret === 1, value_json: s.secret === 1 ? null : s.value_json })),
      registry,
      migrations,
      triggers,
      installed: {
        plugin_id: row.plugin_id,
        version: row.version,
        root_hash: row.root_hash,
        manifest: row.manifest,
        signature_state: row.signature_state,
        test_report_sha: row.test_report_sha,
        runner_image_digest: row.runner_image_digest,
        enabled: row.enabled,
      },
    };
    const staging = `${archivePath}.tmp-${process.pid}`;
    writeFileSync(staging, `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600 });
    renameSync(staging, archivePath);

    const drop = db.transaction(() => {
      for (const table of tables) {
        db.exec(`DROP TRIGGER IF EXISTS "trg_asset_guard_${table.name}"`);
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
      }
      db.prepare(`DELETE FROM cms_trigger_registry WHERE table_name IN (${tables.map(() => '?').join(',') || 'NULL'})`).run(
        ...tables.map((t) => t.name),
      );
      db.prepare('DELETE FROM cms_table_registry WHERE plugin_id = ?').run(row.plugin_id);
      db.prepare('DELETE FROM cms_plugin_migration WHERE plugin_id = ?').run(row.plugin_id);
      db.prepare('DELETE FROM cms_plugin_setting WHERE plugin_id = ?').run(row.plugin_id);
      db.prepare('DELETE FROM cms_plugin_installed WHERE plugin_id = ?').run(row.plugin_id);
    });
    drop();

    // Fold the WAL back into the main file before returning. The app is a **different
    // process** holding its own `-shm` index; after a DDL commit it can serve one more request
    // from a snapshot that predates the drop (measured through the composed gate: `200` on the
    // URL that had just been uninstalled). A TRUNCATE checkpoint makes the new schema the one
    // every reader opens next.
    //
    // `wal_checkpoint` **returns** `{busy, log, checkpointed}` — it does not throw when a
    // reader is mid-request, so the old `try/catch` was dead code and a busy checkpoint was
    // silently skipped (measured: C4 red under `npm run test`, 200 for an uninstalled
    // package). The row is read, and the attempt is repeated while a reader finishes.
    try {
      for (let attempt = 0; attempt < CHECKPOINT_ATTEMPTS; attempt += 1) {
        const rows = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
        if (rows[0] === undefined || rows[0].busy === 0) break;
        pause(CHECKPOINT_PAUSE_MS);
      }
    } catch {
      /* a hard pragma error (a corrupt -shm, a closed handle) is not a reason to fail an
         uninstall that has already committed; the next writer's checkpoint will fold it */
    }

    // After COMMIT: a crash before this leaves a package tree with no row, which the next
    // install replaces and the runner refuses to serve (no row ⇒ no endpoint).
    const target = packageDir(input.pluginsRoot, row.plugin_id);
    const packageRemoved = isDirectory(target);
    if (packageRemoved) rmSync(target, { recursive: true, force: true });

    return {
      plugin: row.plugin_id,
      version: row.version,
      root_hash: row.root_hash,
      archive_path: archivePath,
      tables: tables.map((t) => ({ name: t.name, rows: t.rows.length })),
      settings: settings.length,
      package_removed: packageRemoved,
    };
  } finally {
    db.close();
  }
}

