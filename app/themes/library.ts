/**
 * The box's stock of looks: `data/themes/<key>/`, one copy, many sites.
 *
 * ## Why a library and not a shared row
 *
 * Rendering reads `cms_css_blob`, `cms_theme` and the tenant's own `theme-assets/` — three things
 * that live in a tenant's `site.db` and beside it. Teaching every render path about a second
 * location would mean a schema change, a new URL shape and a new way for a site to be broken by
 * another site's upload. So the library does not participate in rendering at all: it is where a
 * package waits until a site *activates* it, and activation is the copy-in step that already exists
 * (`uploadTheme`, the same function the admin upload door calls).
 *
 * The consequence is honest and deliberate: two sites wearing one library theme have two copies of
 * the bytes with the same key and the same sha, so `/_theme/<key>/…?v=<sha8>` is the same URL on
 * both and a reader cannot tell which box served it.
 *
 * ## What a library entry is
 *
 * Exactly the package format (`skunkworks/theme/v1`), unzipped, plus nothing else. A library entry
 * can be copied to a USB stick and zipped back into a shareable theme with no loss, because it is
 * the same bytes the package carried — the importer never reserialises the sheet.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AppError } from '../errors.ts';
import {
  THEME_MANIFEST_FILE,
  absolutiseCss,
  buildThemePackage,
  readThemePackage,
  sha256Of,
  type ThemePackage,
} from './package.ts';
import {
  activateTheme as activateThemeRow,
  activeThemeKey,
  deactivateTheme,
  deleteTheme,
  themeAssetDir,
  themeAssetsRoot,
  uploadTheme,
} from '../render/themes.ts';

export function libraryRoot(dataDir: string): string {
  return join(dataDir, 'themes');
}

export function libraryEntryDir(dataDir: string, key: string): string {
  return join(libraryRoot(dataDir), key);
}

export interface LibraryEntry {
  key: string;
  name: string;
  version: string;
  cssSha256: string;
  assets: number;
  bytes: number;
  installedAt: string;
  installedFrom: string | null;
}

/** Read one entry's manifest without trusting anything else on disk. */
export function readLibraryTheme(dataDir: string, key: string): ThemePackage {
  const dir = libraryEntryDir(dataDir, key);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new AppError('SKW_E_EXP_THEME_KEY', `the library has no theme ${JSON.stringify(key)}`, { key });
  }
  const members: { path: string; bytes: Buffer }[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const full = join(dir, next);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) members.push({ path: next, bytes: readFileSync(full) });
      else throw new AppError('SKW_E_EXP_THEME_PATH', `${next} is not a regular file`, { path: next });
    }
  };
  walk('');
  const pkg = readThemePackage(members);
  if (pkg.manifest.key !== key) {
    throw new AppError('SKW_E_EXP_THEME_KEY', `the directory ${key} holds the package ${pkg.manifest.key}`, {
      dir: key,
      package: pkg.manifest.key,
    });
  }
  return pkg;
}

/** What the box has. Sorted by key, so two listings of an unchanged box are the same listing. */
export function listLibrary(dataDir: string): LibraryEntry[] {
  const root = libraryRoot(dataDir);
  if (!existsSync(root)) return [];
  const out: LibraryEntry[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const pkg = readLibraryTheme(dataDir, entry.name);
      out.push({
        key: pkg.manifest.key,
        name: pkg.manifest.name,
        version: pkg.manifest.version,
        cssSha256: pkg.manifest.css.sha256,
        assets: pkg.assets.length,
        bytes: pkg.manifest.css.bytes + pkg.assets.reduce((sum, asset) => sum + asset.bytes.length, 0),
        installedAt: pkg.manifest.created_at,
        installedFrom: null,
      });
    } catch {
      // A directory that is not a valid package is not a theme; it is somebody's leftover. Skipping
      // it keeps `theme list` honest instead of failing the whole listing on one stray folder.
      continue;
    }
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

export interface InstallResult {
  key: string;
  dir: string;
  replaced: boolean;
  cssSha256: string;
  assets: number;
}

/**
 * Put a package in the library. Refuses a key collision whose bytes differ, which is the only way
 * two sites can end up wearing two different looks under one URL.
 */
export function installPackage(
  dataDir: string,
  pkg: ThemePackage,
  options: { replace?: boolean; installedFrom?: string } = {},
): InstallResult {
  const key = pkg.manifest.key;
  const dir = libraryEntryDir(dataDir, key);
  const existing = existsSync(dir) ? readLibraryTheme(dataDir, key) : null;
  if (existing !== null && existing.manifest.css.sha256 !== pkg.manifest.css.sha256 && options.replace !== true) {
    throw new AppError('SKW_E_EXP_THEME_DIGEST', `the library already has ${key} with different bytes`, {
      key,
      existing: existing.manifest.css.sha256,
      incoming: pkg.manifest.css.sha256,
    });
  }
  if (existing !== null && options.replace === true) rmSync(dir, { recursive: true, force: true });

  for (const file of pkg.files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  return {
    key,
    dir,
    replaced: existing !== null,
    cssSha256: pkg.manifest.css.sha256,
    assets: pkg.assets.length,
  };
}

export interface ActivateResult {
  key: string;
  themeId: number;
  cssSha256: string;
  assets: number;
  active: boolean;
}

/**
 * Copy a library theme into a tenant: rows, blob and files, through the same `uploadTheme` the
 * admin door uses, so there is one implementation of "a theme is stored" and not two.
 */
export function activatePackage(input: {
  dataDir: string;
  db: Database.Database;
  tenantKey: string;
  key: string;
  actorId: number | null;
  replace?: boolean;
  /** Make it the site's active theme even when another one is active. */
  force?: boolean;
}): ActivateResult {
  const pkg = readLibraryTheme(input.dataDir, input.key);
  const assetsRoot = themeAssetsRoot(input.dataDir, input.tenantKey);
  // Two different shas are in play: the *package* sheet (portable, relative) and the *stored*
  // sheet (the absolute rewrite the browser fetches). A tenant's row holds the stored one, so
  // every comparison against a row must be made in that domain or it will always differ.
  const incomingStored = sha256Of(Buffer.from(absolutiseCss(pkg)));
  const existing = input.db
    .prepare('SELECT id, css_sha256 FROM cms_theme WHERE theme_key = ?')
    .get(input.key) as { id: number; css_sha256: string } | undefined;

  if (existing !== undefined) {
    if (existing.css_sha256 === incomingStored) {
      // Same key, same bytes: activation is idempotent, and it must be, because a re-run of an
      // import should not be an error.
      if (input.force === true) activateThemeRow(input.db, input.key, input.actorId);
      return {
        key: input.key,
        themeId: existing.id,
        cssSha256: existing.css_sha256,
        assets: pkg.assets.length,
        active: activeThemeKey(input.db) === input.key,
      };
    }
    if (input.replace !== true) {
      throw new AppError('SKW_E_EXP_THEME_DIGEST', `tenant ${input.tenantKey} already has ${input.key} with different bytes`, {
        key: input.key,
        existing: existing.css_sha256,
        incoming: incomingStored,
      });
    }
    // `deleteTheme` owns the order (assets, then the row, then the files) and refuses the active
    // theme on purpose — a delete that silently unstyled the live site would be the bug, not the
    // replacement. So: point the site away (only when this key is what it wears), delete, re-add.
    if (activeThemeKey(input.db) === input.key) deactivateTheme(input.db, input.actorId);
    deleteTheme(input.db, input.key, assetsRoot);
  }

  const row = uploadTheme(input.db, {
    name: pkg.manifest.name,
    css: pkg.css,
    sourceName: `theme package ${pkg.manifest.version}`,
    actorId: input.actorId,
    assets: pkg.assets.map((asset) => ({
      path: asset.path,
      bytes: asset.bytes,
      contentType: asset.contentType,
      sha256: asset.sha256,
    })),
    assetsRoot,
    key: input.key,
  });

  const hasActive = activeThemeKey(input.db) !== '';
  const shouldActivate = input.force === true || !hasActive;
  if (shouldActivate) activateThemeRow(input.db, row.key, input.actorId);
  return {
    key: row.key,
    themeId: row.id,
    cssSha256: incomingStored,
    assets: pkg.assets.length,
    active: shouldActivate,
  };
}

/**
 * A tenant's theme as a package, ready to leave the box.
 *
 * The stored sheet is absolute (`/_theme/<key>/…?v=…`); `buildThemePackage` turns it back into the
 * relative form by running the upload rewrite's inverse, so the package this produces is one the
 * importer accepts byte for byte.
 */
export function exportTenantTheme(input: {
  dataDir: string;
  db: Database.Database;
  tenantKey: string;
  key: string;
  now: string;
}): ThemePackage {
  const theme = input.db
    .prepare('SELECT theme_key, name, css_sha256 FROM cms_theme WHERE theme_key = ?')
    .get(input.key) as { theme_key: string; name: string; css_sha256: string } | undefined;
  if (theme === undefined) {
    throw new AppError('SKW_E_EXP_THEME_KEY', `tenant ${input.tenantKey} has no theme ${JSON.stringify(input.key)}`, {
      key: input.key,
    });
  }
  const blob = input.db.prepare('SELECT css FROM cms_css_blob WHERE sha256 = ?').get(theme.css_sha256) as
    | { css: string }
    | undefined;
  if (blob === undefined) {
    throw new AppError('SKW_E_EXP_THEME_REF', `theme ${input.key} names a stylesheet that is not in cms_css_blob`, {
      key: input.key,
      sha256: theme.css_sha256,
    });
  }
  const dir = themeAssetDir(themeAssetsRoot(input.dataDir, input.tenantKey), input.key);
  const assets = input.db
    .prepare(
      `SELECT a.path, a.sha256, a.bytes, a.content_type
         FROM cms_theme_asset a JOIN cms_theme t ON t.id = a.theme_id
        WHERE t.theme_key = ? ORDER BY a.path`,
    )
    .all(input.key) as { path: string; sha256: string; bytes: number; content_type: string }[];
  const members = assets.map((asset) => {
    const file = join(dir, asset.path);
    if (!existsSync(file)) {
      throw new AppError('SKW_E_EXP_THEME_REF', `theme ${input.key} names ${asset.path} but it is not on disk`, {
        key: input.key,
        path: asset.path,
      });
    }
    const bytes = readFileSync(file);
    if (sha256Of(bytes) !== asset.sha256) {
      throw new AppError('SKW_E_EXP_THEME_DIGEST', `theme ${input.key}: ${asset.path} no longer matches its row`, {
        key: input.key,
        path: asset.path,
      });
    }
    return { path: asset.path, bytes, contentType: asset.content_type };
  });

  return buildThemePackage({
    key: input.key,
    name: theme.name,
    css: blob.css,
    assets: members,
    now: input.now,
  });
}

/** Remove an entry. Refuses to remove one a tenant still wears, because that is a foot-gun. */
export function removeLibraryTheme(dataDir: string, key: string, tenants: readonly Database.Database[]): void {
  const dir = libraryEntryDir(dataDir, key);
  if (!existsSync(dir)) {
    throw new AppError('SKW_E_EXP_THEME_KEY', `the library has no theme ${JSON.stringify(key)}`, { key });
  }
  for (const db of tenants) {
    const row = db.prepare('SELECT 1 FROM cms_theme WHERE theme_key = ?').get(key);
    if (row !== undefined) {
      throw new AppError('SKW_E_EXP_THEME_REF', `a tenant still has ${key}; deactivate or delete it there first`, {
        key,
      });
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

export const THEME_LIBRARY_INDEX = THEME_MANIFEST_FILE;
