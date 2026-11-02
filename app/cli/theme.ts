#!/usr/bin/env node
/**
 * `skw-theme` — themes in and out of a box, and onto a site.
 *
 *     skw-theme list   [--library | --tenant <key>] [--data-dir <dir>]
 *     skw-theme import <file.zip|dir> [--data-dir <dir>] [--replace]
 *     skw-theme export <key> --tenant <key> --out <dir> [--data-dir <dir>] [--now <ISO 8601>]
 *     skw-theme activate <key> --tenant <key> [--data-dir <dir>] [--replace] [--force]
 *     skw-theme remove <key> [--data-dir <dir>]
 *
 * Exit codes are the house's: 0 done, 1 refused (and the refusal is printed *with* its code),
 * 2 bad usage. A refusal never leaves a half-written library entry or a half-activated theme —
 * every check runs before the first write, and the write itself is the existing `uploadTheme`
 * (row + blob + files) or a whole-package directory write.
 *
 * The data directory is the box's `data/`: `SKW_DATA_DIR`, or `--data-dir`, or `./data`.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { AppError } from '../errors.ts';
import { openAdminWrite } from '../db/classes.ts';
import { readZip } from '../render/zip.ts';
import {
  activatePackage,
  exportTenantTheme,
  installPackage,
  libraryEntryDir,
  listLibrary,
  readLibraryTheme,
  removeLibraryTheme,
} from '../themes/library.ts';
import { readThemePackage, readThemePackageZip } from '../themes/package.ts';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

interface Args {
  command: string | undefined;
  key: string | undefined;
  tenant: string | undefined;
  out: string | undefined;
  archive: string | undefined;
  dataDir: string;
  now: string | undefined;
  replace: boolean;
  force: boolean;
  library: boolean;
  help: boolean;
}

function parse(argv: readonly string[]): Args {
  const args: Args = {
    command: undefined,
    key: undefined,
    tenant: undefined,
    out: undefined,
    archive: undefined,
    dataDir: process.env.SKW_DATA_DIR ?? 'data',
    now: undefined,
    replace: false,
    force: false,
    library: false,
    help: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === undefined) break;
    const value = argv[i + 1];
    const take = (): string => {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case '--tenant':
        args.tenant = take();
        break;
      case '--out':
        args.out = take();
        break;
      case '--archive':
        args.archive = take();
        break;
      case '--data-dir':
        args.dataDir = take();
        break;
      case '--now':
        args.now = take();
        break;
      case '--replace':
        args.replace = true;
        break;
      case '--force':
        args.force = true;
        break;
      case '--library':
        args.library = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (flag.startsWith('-')) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
        positionals.push(flag);
    }
  }
  args.command = positionals[0];
  args.key = positionals[1];
  return args;
}

const USAGE = `usage:
  skw-theme list [--library | --tenant <key>] [--data-dir <dir>]
  skw-theme import <file.zip|dir> [--replace] [--data-dir <dir>]
  skw-theme export <key> --tenant <key> --out <dir> [--now <ISO 8601>] [--data-dir <dir>]
  skw-theme activate <key> --tenant <key> [--replace] [--force] [--data-dir <dir>]
  skw-theme remove <key> [--data-dir <dir>]`;

function siteDbPath(dataDir: string, tenant: string): string {
  return join(dataDir, 'tenants', tenant, 'site.db');
}

/** Every tenant DB the box has, opened read/write, for the commands that must look at all of them. */
function openTenants(dataDir: string): { key: string; db: Database.Database }[] {
  const root = join(dataDir, 'tenants');
  if (!existsSync(root)) return [];
  const out: { key: string; db: Database.Database }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, 'site.db');
    if (!existsSync(file)) continue;
    out.push({ key: entry.name, db: openAdminWrite(file) });
  }
  return out;
}

/** A package from either a `.zip` or a directory that already has the package's shape. */
function readPackageInput(path: string): ReturnType<typeof readThemePackage> {
  if (!existsSync(path)) throw new AppError('SKW_E_EXP_THEME_KEY', `${path} does not exist`, { path });
  if (statSync(path).isDirectory()) {
    const members: { path: string; bytes: Buffer }[] = [];
    const walk = (relative: string): void => {
      for (const entry of readdirSync(join(path, relative), { withFileTypes: true })) {
        const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(next);
        else if (entry.isFile()) members.push({ path: next, bytes: readFileSync(join(path, next)) });
        else throw new AppError('SKW_E_EXP_THEME_PATH', `${next} is not a regular file`, { path: next });
      }
    };
    walk('');
    return readThemePackage(members);
  }
  if (!/\.zip$/i.test(path)) {
    throw new AppError('SKW_E_EXP_THEME_SCHEMA', `${basename(path)} is neither a .zip nor a package directory`, {
      path,
    });
  }
  return readThemePackageZip(readFileSync(path));
}

function list(args: Args): number {
  if (args.tenant !== undefined) {
    const file = siteDbPath(args.dataDir, args.tenant);
    if (!existsSync(file)) throw new AppError('SKW_E_EXP_TENANT_NOT_FOUND', `no tenant ${args.tenant}`, { tenant: args.tenant });
    const db = openAdminWrite(file);
    try {
      const rows = db
        .prepare(
          `SELECT t.theme_key, t.name, t.css_sha256,
                  (SELECT COUNT(*) FROM cms_theme_asset a WHERE a.theme_id = t.id) AS assets,
                  COALESCE((SELECT value_json = '"' || t.theme_key || '"' FROM cms_settings WHERE key = 'site.theme_key'), 0) AS active
             FROM cms_theme t ORDER BY t.theme_key`,
        )
        .all() as { theme_key: string; name: string; css_sha256: string; assets: number; active: number }[];
      if (rows.length === 0) process.stdout.write('tenant: no themes\n');
      for (const row of rows) {
        process.stdout.write(
          `tenant ${args.tenant}  ${row.theme_key}  "${row.name}"  ${row.assets} asset(s)  ${row.css_sha256.slice(0, 12)}  ${row.active ? 'active' : ''}\n`,
        );
      }
    } finally {
      db.close();
    }
    return EXIT_OK;
  }

  const entries = listLibrary(args.dataDir);
  if (entries.length === 0) process.stdout.write('library: empty\n');
  for (const entry of entries) {
    process.stdout.write(
      `library  ${entry.key}  "${entry.name}"  v${entry.version}  ${entry.assets} asset(s)  ${entry.bytes} B  ${entry.cssSha256.slice(0, 12)}\n`,
    );
  }
  return EXIT_OK;
}

function importPackage(args: Args): number {
  if (args.key === undefined) throw new AppError('SKW_E_EXP_THEME_KEY', 'import needs a file or a directory');
  const pkg = readPackageInput(args.key);
  const result = installPackage(args.dataDir, pkg, { replace: args.replace, installedFrom: basename(args.key) });
  process.stdout.write(
    `theme import: ${result.key} "${pkg.manifest.name}" v${pkg.manifest.version} -> ${result.dir} ` +
      `(${pkg.assets.length} asset(s), ${result.replaced ? 'replaced' : 'new'}, css ${result.cssSha256.slice(0, 12)})\n`,
  );
  return EXIT_OK;
}

function exportTheme(args: Args): number {
  if (args.key === undefined || args.tenant === undefined || args.out === undefined) {
    throw new AppError('SKW_E_EXP_THEME_KEY', 'export needs <key> --tenant <key> --out <dir>');
  }
  const now = args.now ?? new Date().toISOString();
  const file = siteDbPath(args.dataDir, args.tenant);
  if (!existsSync(file)) throw new AppError('SKW_E_EXP_TENANT_NOT_FOUND', `no tenant ${args.tenant}`, { tenant: args.tenant });
  const db = openAdminWrite(file);
  let pkg;
  try {
    pkg = exportTenantTheme({ dataDir: args.dataDir, db, tenantKey: args.tenant, key: args.key, now });
  } finally {
    db.close();
  }
  mkdirSync(args.out, { recursive: true });
  for (const entry of pkg.files) {
    const target = join(args.out, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSyncAtomic(target, entry.bytes);
  }
  process.stdout.write(
    `theme export: ${pkg.manifest.key} v${pkg.manifest.version} -> ${args.out} ` +
      `(${pkg.files.length} file(s), css ${pkg.manifest.css.sha256.slice(0, 12)}, now ${now})\n`,
  );
  return EXIT_OK;
}

function activate(args: Args): number {
  if (args.key === undefined || args.tenant === undefined) {
    throw new AppError('SKW_E_EXP_THEME_KEY', 'activate needs <key> --tenant <key>');
  }
  const file = siteDbPath(args.dataDir, args.tenant);
  if (!existsSync(file)) throw new AppError('SKW_E_EXP_TENANT_NOT_FOUND', `no tenant ${args.tenant}`, { tenant: args.tenant });
  const db = openAdminWrite(file);
  try {
    const result = activatePackage({
      dataDir: args.dataDir,
      db,
      tenantKey: args.tenant,
      key: args.key,
      actorId: null,
      replace: args.replace,
      force: args.force,
    });
    process.stdout.write(
      `theme activate: ${result.key} on ${args.tenant} (theme #${result.themeId}, ${result.assets} asset(s), ` +
        `css ${result.cssSha256.slice(0, 12)}, ${result.active ? 'active' : 'installed, not active'})\n`,
    );
  } finally {
    db.close();
  }
  return EXIT_OK;
}

function remove(args: Args): number {
  if (args.key === undefined) throw new AppError('SKW_E_EXP_THEME_KEY', 'remove needs <key>');
  const tenants = openTenants(args.dataDir);
  try {
    removeLibraryTheme(
      args.dataDir,
      args.key,
      tenants.map((tenant) => tenant.db),
    );
  } finally {
    for (const tenant of tenants) tenant.db.close();
  }
  process.stdout.write(`theme remove: ${args.key} gone from ${libraryEntryDir(args.dataDir, args.key)}\n`);
  return EXIT_OK;
}

function writeFileSyncAtomic(target: string, bytes: Buffer): void {
  // Write beside, then rename: a half-written theme.css is a theme that renders as nothing.
  const temp = `${target}.tmp-${String(process.pid)}`;
  writeFileSync(temp, bytes);
  renameSync(temp, target);
}

export async function run(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parse(argv);
  } catch (err) {
    process.stderr.write(`skw-theme: ${(err as Error).message}\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (args.help || args.command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return args.help ? EXIT_OK : EXIT_USAGE;
  }
  try {
    switch (args.command) {
      case 'list':
        return list(args);
      case 'import':
        return importPackage(args);
      case 'export':
        return exportTheme(args);
      case 'activate':
        return activate(args);
      case 'remove':
        return remove(args);
      default:
        process.stderr.write(`skw-theme: unknown command ${JSON.stringify(args.command)}\n${USAGE}\n`);
        return EXIT_USAGE;
    }
  } catch (err) {
    if (err instanceof AppError) {
      process.stderr.write(`REFUSAL: ${err.code}: ${err.message} ${JSON.stringify(err.detail ?? {})}\n`);
      return EXIT_REFUSED;
    }
    throw err;
  }
}

// Run unconditionally, the way `skw-export` does: this file is an entry point, not a library, and
// a `import.meta.url === file://${process.argv[1]}` guard is itself a runtime-path decision the
// dist witness has to claim (it caught exactly that here).
run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`skw-theme: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
