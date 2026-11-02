/**
 * What the portal hands an operator: one file per action.
 *
 * The CLI already knows how to cut a site bundle and a theme package; the portal must not fork that
 * logic. So this module is a thin, synchronous wrapper: build through the same functions the CLI
 * calls (`runExport`, `exportTenantTheme`), then put the result in a zip with the deterministic
 * writer. Nothing here re-derives a URL, a hash or a page.
 *
 * ## Where the platform root comes from
 *
 * `planCms` needs the repository tree for `install.sh`, `nginx/`, `tools/`, `schema/` and the
 * compose file. A deployed image has those beside the app (`/srv/app`), and a source checkout has
 * them at the repo root — `findProjectRoot()` walks up until it sees `schema/site.sql`, so both
 * resolve without new configuration.
 *
 * ## Cost
 *
 * A cms export runs `VACUUM INTO` and writes ~30 files before zipping. It is an operator action, not
 * a page render, so it happens inside the request: a few hundred milliseconds on a small site. The
 * temp tree is removed in a `finally`, so a failure cannot leave a half bundle on disk.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { AppError } from '../errors.ts';
import { findProjectRoot } from '../db/migrate.ts';
import { runExport } from './index.ts';
import { buildArchive } from './archive.ts';
import type { TreeFile } from './tree.ts';
import { exportTenantTheme } from '../themes/library.ts';
import type { HostSpec, TenantSpec } from './cms.ts';

export interface PortalFile {
  name: string;
  bytes: Buffer;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'site';
}

/** `data/` for a deployed image, the checkout for a source tree — both work. */
export function platformRoot(): string {
  return findProjectRoot();
}

export function contentRootFor(repoRoot: string, dataDir: string): string {
  const inRepo = join(repoRoot, 'content');
  return existsSync(inRepo) ? inRepo : join(dataDir, 'content');
}

/** The tenant's control-plane facts, read once from `control.db`. */
export function tenantSpecFor(controlDbPath: string, key: string): TenantSpec {
  const db = new Database(controlDbPath, { readonly: true, fileMustExist: true });
  try {
    const tenant = db
      .prepare('SELECT key, mode, status, display_name, db_version FROM tenant WHERE key = ?')
      .get(key) as
      | { key: string; mode: string; status: string; display_name: string; db_version: number }
      | undefined;
    if (tenant === undefined) {
      throw new AppError('SKW_E_EXP_TENANT_NOT_FOUND', `no tenant ${JSON.stringify(key)}`, { key });
    }
    const hosts = db
      .prepare(
        `SELECT host, kind, is_primary, cert_state FROM domain
          WHERE tenant_id = (SELECT id FROM tenant WHERE key = ?)
          ORDER BY is_primary DESC, host`,
      )
      .all(key) as HostSpec[];
    if (hosts.length === 0) {
      throw new AppError('SKW_E_EXP_TENANT_NOT_FOUND', `tenant ${key} has no domain rows`, { key });
    }
    return {
      key: tenant.key,
      mode: tenant.mode,
      status: tenant.status,
      displayName: tenant.display_name,
      dbVersion: tenant.db_version,
      hosts,
    };
  } finally {
    db.close();
  }
}

/** Every file and symlink under `root`, as tree entries with forward-slash paths. */
function treeEntries(root: string): TreeFile[] {
  const entries: TreeFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const path = relative(root, full).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        entries.push({ path, symlink: readlinkSync(full) });
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) {
        throw new AppError('SKW_E_EXP_THEME_PATH', `${path} is not a regular file`, { path });
      }
      const stats = lstatSync(full);
      // An installer must stay executable after a round trip; everything else is data.
      const mode = stats.mode & 0o111 ? 0o755 : 0o644;
      entries.push({ path, bytes: readFileSync(full), mode });
    }
  };
  walk(root);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

export interface SiteExportInput {
  dataDir: string;
  controlDbPath: string;
  tenantKey: string;
  /** The tenant's database, opened by the caller (read/write is fine: `VACUUM INTO` needs a handle). */
  db: Database.Database;
  now: string;
  origin?: string;
  repoRoot?: string;
}

/** The whole site as one `.zip`: the same tree `skw-export --target cms` writes, in one file. */
export function exportSiteZip(input: SiteExportInput): PortalFile {
  const repoRoot = input.repoRoot ?? platformRoot();
  const scratch = join(input.dataDir, 'tmp');
  mkdirSync(scratch, { recursive: true });
  const staging = mkdtempSync(join(scratch, 'portal-export-'));
  const out = join(staging, 'bundle');
  try {
    const result = runExport({
      target: 'cms',
      db: input.db,
      tenantKey: input.tenantKey,
      out,
      exportNow: input.now,
      contentRoot: contentRootFor(repoRoot, input.dataDir),
      repoRoot,
      // `planCms` reads a tenant's theme files from `<tmpDir>/tenants/<key>/theme-assets/…`, so this
      // is the *data* directory, not the scratch directory — the CLI passes the same thing.
      tmpDir: input.dataDir,
      tenant: tenantSpecFor(input.controlDbPath, input.tenantKey),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    });
    if (!result.ok) {
      throw new AppError(
        result.refusals[0]?.code ?? 'SKW_E_EXP_ASSET_UNRESOLVED',
        result.refusals.map((refusal) => refusal.message).join('; '),
        { refusals: result.refusals },
      );
    }
    const entries = treeEntries(out);
    return {
      name: `${slug(input.tenantKey)}-site-${input.now.slice(0, 10)}.zip`,
      bytes: buildArchive('zip', entries, Date.parse(input.now)),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface ThemeExportInput {
  dataDir: string;
  db: Database.Database;
  tenantKey: string;
  key: string;
  now: string;
}

/** One theme as one `.zip`, in the package format the importer accepts. */
export function exportThemeZip(input: ThemeExportInput): PortalFile {
  const pkg = exportTenantTheme({
    dataDir: input.dataDir,
    db: input.db,
    tenantKey: input.tenantKey,
    key: input.key,
    now: input.now,
  });
  const entries: TreeFile[] = pkg.files
    .map((file) => ({ path: file.path, bytes: file.bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    name: `${slug(input.key)}-theme-${input.now.slice(0, 10)}.zip`,
    bytes: buildArchive('zip', entries, Date.parse(input.now)),
  };
}

/** A download needs a filename that cannot become a header injection. */
export function safeDownloadName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
}

/** Only used by tests: the sha of an archive, so a download can be compared with a CLI export. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export { buildArchive };
export { dirname };
