/**
 * `migrate` — SDS §2.3 steps 3-4, §12.4, C-10.
 *
 *   migrate exits 0 with a JSON report naming every tenant it migrated and every
 *   tenant it could not; app starts regardless; a failure to migrate control.db
 *   prevents startup with exit 15 and a message naming the migration.
 *
 * No `migrate` service exists in compose (§12.1): `app` runs this itself.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backfillCssBlobs } from '../render/themes.ts';

export const EXIT_OK = 0;
export const EXIT_CONTROL_FAILED = 15;

export type Action = 'created' | 'migrated' | 'skipped' | 'failed';

export interface StepReport {
  path: string;
  from: number;
  to: number;
  action: Action;
  ok: boolean;
  error?: string;
}

export interface TenantReport extends StepReport {
  key: string;
}

export interface MigrationReport {
  ok: boolean;
  at: string;
  dataDir: string;
  control: StepReport;
  tenants: TenantReport[];
  migrated: string[];
  failed: { key: string; error: string }[];
}

export interface MigrateOptions {
  dataDir: string;
  schemaDir?: string;
  tenant?: string;
  now?: () => Date;
}

export function targetVersion(ddlPath: string): number {
  const sql = readFileSync(ddlPath, 'utf8');
  const m = /PRAGMA\s+user_version\s*=\s*(\d+)\s*;/i.exec(sql);
  if (m === null) throw new Error(`no PRAGMA user_version in ${ddlPath}`);
  return Number(m[1]);
}

function userVersion(db: Database.Database): number {
  const v = db.pragma('user_version', { simple: true });
  return Number(v);
}

function applyDdl(db: Database.Database, ddlPath: string): void {
  db.exec(readFileSync(ddlPath, 'utf8'));
}

/** The message an operator can act on: the file that failed and why. */
function describe(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e.code !== undefined) return e.code;
  return e.message ?? 'unknown error';
}

export function migrateControl(controlPath: string, schemaDir: string): StepReport {
  const ddl = join(schemaDir, 'control.sql');
  const amend2 = join(schemaDir, 'control-r2.sql');
  const amend3 = join(schemaDir, 'control-r3.sql');
  // E-20 (02-errata §8): the control plane is at v4 and `audit_seal` is a day segment.
  const amend4 = join(schemaDir, 'control-r4.sql');
  const target = targetVersion(ddl);
  const rel = 'control.db';

  if (!existsSync(controlPath)) {
    mkdirSync(dirname(controlPath), { recursive: true });
    let db: Database.Database | undefined;
    try {
      db = new Database(controlPath);
      db.pragma('journal_mode = WAL');
      applyDdl(db, ddl);
      return { path: rel, from: 0, to: userVersion(db), action: 'created', ok: true };
    } catch (err) {
      return { path: rel, from: 0, to: target, action: 'failed', ok: false, error: `control.sql: ${describe(err)}` };
    } finally {
      db?.close();
    }
  }

  let db: Database.Database | undefined;
  let from = 0;
  try {
    db = new Database(controlPath);
    from = userVersion(db);
    if (from === target) return { path: rel, from, to: target, action: 'skipped', ok: true };
    if (from > target) {
      return { path: rel, from, to: from, action: 'failed', ok: false, error: `control.db user_version ${from} is newer than this image (${target})` };
    }
    if (from === 0) {
      applyDdl(db, ddl);
      return { path: rel, from, to: userVersion(db), action: 'created', ok: true };
    }
    let at = from;
    if (at === 1) {
      applyDdl(db, amend2);
      at = userVersion(db);
    }
    if (at === 2) {
      applyDdl(db, amend3);
      at = userVersion(db);
    }
    if (at === 3) {
      applyDdl(db, amend4);
      at = userVersion(db);
    }
    if (at !== target) {
      return { path: rel, from, to: at, action: 'failed', ok: false, error: `no migration path from control.db v${at} to v${target}` };
    }
    return { path: rel, from, to: at, action: 'migrated', ok: true };
  } catch (err) {
    return { path: rel, from, to: target, action: 'failed', ok: false, error: `control migration: ${describe(err)}` };
  } finally {
    db?.close();
  }
}

export function migrateTenant(dbPath: string, siteKey: string, schemaDir: string): TenantReport {
  const ddl = join(schemaDir, 'site.sql');
  const r2 = join(schemaDir, 'r2-amendments.sql');
  const r3 = join(schemaDir, 'r3-amendments.sql');
  const r4 = join(schemaDir, 'r4-amendments.sql');
  const r5 = join(schemaDir, 'r5-amendments.sql');
  const r6 = join(schemaDir, 'r6-amendments.sql');
  const r7 = join(schemaDir, 'r7-amendments.sql');
  const r8 = join(schemaDir, 'r8-amendments.sql');
  // S9/v9: the application lives in core, because a plugin's EndpointRequest carries no actor.
  const r9 = join(schemaDir, 'r9-amendments.sql');
  const target = targetVersion(ddl);
  const rel = join('tenants', siteKey, 'site.db');
  const base = { key: siteKey, path: rel };

  if (!existsSync(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true });
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      applyDdl(db, ddl);
      return { ...base, from: 0, to: userVersion(db), action: 'created', ok: true };
    } catch (err) {
      return { ...base, from: 0, to: target, action: 'failed', ok: false, error: `site.sql: ${describe(err)}` };
    } finally {
      db?.close();
    }
  }

  let db: Database.Database | undefined;
  let from = 0;
  try {
    db = new Database(dbPath);
    from = userVersion(db);
    if (from === target) return { ...base, from, to: target, action: 'skipped', ok: true };
    if (from > target) {
      return { ...base, from, to: from, action: 'failed', ok: false, error: `user_version ${from} is newer than this image (${target})` };
    }
    if (from === 0) {
      applyDdl(db, ddl);
      return { ...base, from, to: userVersion(db), action: 'created', ok: true };
    }
    let at = from;
    if (at === 1) {
      applyDdl(db, r2);
      at = userVersion(db);
    }
    if (at === 2) {
      applyDdl(db, r3);
      at = userVersion(db);
    }
    if (at === 3) {
      // E-31 item 5: the durable activation counter. One ADD COLUMN, no rebuild.
      applyDdl(db, r4);
      at = userVersion(db);
    }
    if (at === 4) {
      // E-35: `body_*` is the published body and `draft_*` the work in progress. Four ADD
      // COLUMNs, no rebuild, and every existing row gets an empty draft.
      applyDdl(db, r5);
      at = userVersion(db);
    }
    if (at === 5) {
      // E-49: a stylesheet needs a name that is its own bytes (`/_css/<sha>.css`, cacheable for
      // ever) and a theme needs to be a row someone can swap, not a text field someone retypes.
      // Two CREATE TABLEs, no rebuild: no existing table is touched.
      applyDdl(db, r6);
      at = userVersion(db);
      // The blobs are what a document's `/_css/<sha>.css` link resolves to, and a sha256 is not a
      // SQLite function — so every stylesheet already in the file is named here, once. Idempotent
      // (`INSERT OR IGNORE` on the name it computes), so a re-run writes nothing.
      backfillCssBlobs(db);
    }
    if (at === 6) {
      // S8x: a theme is a package, not a stylesheet. One CREATE TABLE, no rebuild: the themes a
      // tenant already has are stylesheets with no assets, which is exactly what their rows say.
      applyDdl(db, r7);
      at = userVersion(db);
    }
    if (at === 7) {
      // S9: the board's people. Seven CREATE TABLEs and their indexes — identity, the profile a
      // stranger owns, and the outbox. No rebuild and no backfill: a tenant that has never had a
      // public account simply has no rows, which is what every tenant is on the day this lands.
      applyDdl(db, r8);
      at = userVersion(db);
    }
    if (at === 8) {
      // S9/v9: the act of applying. One CREATE TABLE and its indexes. Core rather than the job
      // board plugin's, because a plugin request carries no actor and this row is the grant an
      // advertiser's view of a stranger's profile depends on.
      applyDdl(db, r9);
      at = userVersion(db);
    }
    if (at !== target) {
      return { ...base, from, to: at, action: 'failed', ok: false, error: `no migration path from v${at} to v${target}` };
    }
    return { ...base, from, to: at, action: 'migrated', ok: true };
  } catch (err) {
    return { ...base, from, to: target, action: 'failed', ok: false, error: describe(err) };
  } finally {
    db?.close();
  }
}

export function runMigrations(opts: MigrateOptions): MigrationReport {
  const schemaDir = opts.schemaDir ?? defaultSchemaDir();
  const controlPath = join(opts.dataDir, 'control.db');
  const control = migrateControl(controlPath, schemaDir);

  const report: MigrationReport = {
    ok: control.ok,
    at: (opts.now ?? (() => new Date()))().toISOString(),
    dataDir: opts.dataDir,
    control,
    tenants: [],
    migrated: [],
    failed: [],
  };
  if (!control.ok) return report;

  const db = new Database(controlPath, { readonly: true });
  let keys: string[] = [];
  try {
    const rows = db.prepare('SELECT key FROM tenant ORDER BY key').all() as { key: string }[];
    keys = rows.map((r) => r.key);
  } finally {
    db.close();
  }
  if (opts.tenant !== undefined && opts.tenant !== 'all') keys = keys.filter((k) => k === opts.tenant);

  for (const key of keys) {
    const dbPath = join(opts.dataDir, 'tenants', key, 'site.db');
    const t = migrateTenant(dbPath, key, schemaDir);
    report.tenants.push(t);
    if (t.ok && t.action !== 'skipped') report.migrated.push(key);
    if (!t.ok) report.failed.push({ key, error: t.error ?? 'failed' });
  }
  return report;
}

/**
 * The image root, found by walking up for schema/site.sql. The same code runs
 * from app/ (source, tests) and from dist/app/ (the image), which are at
 * different depths — a fixed number of `..` is wrong for one of them.
 */
export function findProjectRoot(startDir: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = startDir;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'schema', 'site.sql'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function defaultSchemaDir(): string {
  return join(findProjectRoot(), 'schema');
}

function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(metaUrl);
  return self === entry || relative(process.cwd(), entry) === relative(process.cwd(), self);
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  let tenant = 'all';
  let dataDir = process.env.SKW_DATA_DIR ?? '/srv/data';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant') tenant = argv[i + 1] ?? 'all';
    else if (arg === '--data-dir') dataDir = argv[i + 1] ?? dataDir;
  }
  const report = runMigrations({ dataDir, tenant });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.control.ok) {
    process.stderr.write(
      `refusing to start: control.db could not be migrated (${report.control.error ?? 'unknown'}) (SDS \u00a72.3 step 3, C-10)\n`,
    );
    return EXIT_CONTROL_FAILED;
  }
  return EXIT_OK;
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
