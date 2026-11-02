/**
 * S8s: themes are rows, and stylesheets are files.
 *
 * ## Why a theme is not a settings string
 *
 * It was one: `site.theme_css`, a textarea on the Site screen. That is a value, not a theme — it
 * cannot be kept beside its predecessor, swapped back when the new one is worse, or previewed
 * before it goes live. So an upload is a row in `cms_theme`, and the CSS itself is a row in
 * `cms_css_blob`, keyed by the sha256 of its own bytes.
 *
 * **Exactly one theme is active** because the active theme is a single value:
 * `cms_settings.site.theme_key` names one row, or none. There is no boolean on the theme to keep
 * in step with the others, so two themes cannot both be on — not by rule, by shape. An empty
 * pointer falls back to the pasted `site.theme_css`, which is what a tenant seeded by an older
 * image has and what an operator with a one-line override still finds useful.
 *
 * ## Why the blob
 *
 * A stylesheet the browser must never revalidate needs a URL that names its bytes: `_css/<sha>.css`
 * is immutable by construction, so two pages that share a sheet share a file and a navigation
 * paints from cache instead of paying a conditional request in front of the first pixel (E-48).
 * The alternative — `/page.css?path=/about` — needs a validator on every request and puts the
 * cache behind a query string, which is the shape E-48 measured as the menu delay.
 *
 * The blob is also what makes an export honest: the tree writes exactly the files its documents
 * name, no more and no fewer.
 *
 * ## What this module refuses
 *
 * A CSS file is not markup, but it is served from the tenant's own origin as `text/css` with
 * `nosniff`, so a `</style` or a `<script` in it is a mistake worth naming rather than serving.
 * A theme with no bytes, or over `THEME_MAX_BYTES`, is refused for the same reason a 40 MB image
 * is: the site is not a file share.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import { THEME_MAX_BYTES, rewriteAssetUrls, type ThemeAsset } from './theme-bundle.ts';

export { THEME_MAX_BYTES };
export type { ThemeAsset };

/** The pointer. One value, therefore one active theme. */
export const THEME_KEY_SETTING = 'site.theme_key';

/**
 * A theme is a stylesheet a person wrote; 512 KiB is generous for one and small enough to read.
 * The number lives in `theme-bundle.ts`, beside the reader that enforces it on a package's sheet,
 * so a `.css` upload and a `.zip` upload cannot disagree about the ceiling.
 */

/** The most a `cms_css_blob` row may hold — the schema's CHECK is the second lock. */
export const CSS_MAX_BYTES = 1024 * 1024;

export interface ThemeRow {
  id: number;
  key: string;
  name: string;
  cssSha: string;
  css: string;
  bytes: number;
  sourceName: string | null;
  createdAt: string;
  active: boolean;
  /** How many files the package carried, and how much they weigh. */
  assetCount: number;
  assetBytes: number;
}

/** One file a theme's stylesheet names. The bytes are on disk; this is the row that names them. */
export interface ThemeAssetRow {
  path: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

/**
 * Where a tenant's theme files live: `tenants/<key>/theme-assets/<theme_key>/<path>`.
 *
 * Beside the tenant's `site.db` and not in `content/`: content is what the media library owns and
 * what an export copies as `media/`, and a theme's files are neither — they are part of a look, they
 * are served from `/_theme/<key>/…`, and they are deleted with the theme.
 */
export function themeAssetsRoot(dataDir: string, tenantKey: string): string {
  return join(dataDir, 'tenants', tenantKey, 'theme-assets');
}

export function themeAssetDir(root: string, themeKey: string): string {
  return join(root, themeKey);
}

/** `/admin`-free and tenant-scoped: the URL a rewritten stylesheet refers to. */
export function themeAssetPath(themeKey: string, path: string): string {
  return join(themeAssetDir('', themeKey), path);
}

/** How long a theme preview link works. Long enough to look, short enough to not linger. */
export const PREVIEW_TTL_MS = 15 * 60 * 1000;

/**
 * The preview token: `tenant|theme|exp`, HMAC'd with the app's session key.
 *
 * It exists because the admin session cookie is scoped to `Path=/admin` and is therefore never
 * sent to a page URL — so a preview of the *site* cannot authenticate with it. A signed token in
 * the URL travels with a link a colleague pastes into chat, works once for fifteen minutes, and
 * reveals only a theme key the operator chose.
 */
export function previewToken(secret: string, tenantKey: string, themeKey: string, atMs: number): string {
  const exp = atMs + PREVIEW_TTL_MS;
  const mac = createHmac('sha256', secret).update(`${tenantKey}|${themeKey}|${exp}`).digest('base64url');
  return `${exp}.${mac}`;
}

/**
 * The theme key the token names, or `null`. Constant-time on the mac, expiry checked first.
 *
 * The token carries `exp.mac` and not the theme key, so verification tries each theme the tenant
 * has — one indexed read and a handful of HMACs. Carrying the key would save them and hand the key
 * to anyone holding the link, which is the wrong trade for something that lasts fifteen minutes.
 * `candidates` is passed in rather than read from a table so this stays a pure function.
 */
export function verifyPreviewToken(
  secret: string,
  token: string,
  tenantKey: string,
  candidates: readonly string[],
): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const exp = Number(token.slice(0, dot));
  const mac = token.slice(dot + 1);
  if (!Number.isSafeInteger(exp) || exp < Date.now() || mac === '') return null;
  const got = Buffer.from(mac);
  let found: string | null = null;
  for (const themeKey of candidates) {
    const want = createHmac('sha256', secret).update(`${tenantKey}|${themeKey}|${exp}`).digest('base64url');
    const bytes = Buffer.from(want);
    // No early exit: the loop's work must not depend on which candidate matched.
    if (bytes.length === got.length && timingSafeEqual(bytes, got)) found = themeKey;
  }
  return found;
}

interface ThemeJoin {
  id: number;
  theme_key: string;
  name: string;
  css_sha256: string;
  css: string;
  bytes: number;
  source_name: string | null;
  created_at: string;
  asset_count: number;
  asset_bytes: number;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Store a stylesheet once and return its name. `INSERT OR IGNORE` because the sha is the identity:
 * uploading the same bytes twice is one file, which is the point of content addressing.
 */
export function putCssBlob(db: Database.Database, css: string): string {
  if (css === '') throw new AppError('SKW_E_PL_INTERNAL', 'an empty stylesheet has no name');
  const bytes = Buffer.byteLength(css, 'utf8');
  if (bytes > CSS_MAX_BYTES) {
    throw new AppError('SKW_E_PL_REJECTED', `a stylesheet over ${CSS_MAX_BYTES} bytes is refused`, {
      bytes,
    });
  }
  const sha = sha256(css);
  db.prepare(`INSERT OR IGNORE INTO cms_css_blob (sha256, css, bytes) VALUES (?, ?, ?)`).run(sha, css, bytes);
  return sha;
}

export function cssBlob(db: Database.Database, sha: string): string | undefined {
  const row = db.prepare(`SELECT css FROM cms_css_blob WHERE sha256 = ?`).get(sha) as
    | { css: string }
    | undefined;
  return row?.css;
}

/**
 * Put every stylesheet the database already holds into the blob table.
 *
 * The migration cannot do this in SQL — a sha256 is not a SQLite function — so it happens here,
 * once, at v5 → v6, and idempotently: `putCssBlob` is `INSERT OR IGNORE` on the name it computes.
 * A page or a pasted theme that existed before this feature therefore keeps the CSS it always had,
 * and its document starts naming a file that exists.
 */
export function backfillCssBlobs(db: Database.Database): number {
  let written = 0;
  const pages = db.prepare(`SELECT body_css, draft_css FROM cms_page`).all() as {
    body_css: string | null;
    draft_css: string | null;
  }[];
  for (const row of pages) {
    for (const css of [row.body_css ?? '', row.draft_css ?? '']) {
      if (css !== '') {
        putCssBlob(db, css);
        written += 1;
      }
    }
  }
  const theme = db.prepare(`SELECT value_json FROM cms_settings WHERE key = 'site.theme_css'`).get() as
    | { value_json: string }
    | undefined;
  if (theme !== undefined) {
    try {
      const css: unknown = JSON.parse(theme.value_json);
      if (typeof css === 'string' && css !== '') {
        putCssBlob(db, css);
        written += 1;
      }
    } catch {
      /* a damaged settings row is not a reason to fail a migration */
    }
  }
  return written;
}

/** The pointer, as stored. `''` when nothing has ever been activated. */
export function activeThemeKey(db: Database.Database): string {
  const row = db.prepare(`SELECT value_json FROM cms_settings WHERE key = ?`).get(THEME_KEY_SETTING) as
    | { value_json: string }
    | undefined;
  if (row === undefined) return '';
  try {
    const value: unknown = JSON.parse(row.value_json);
    return typeof value === 'string' ? value : '';
  } catch {
    // A damaged pointer is not a reason to fail every request on the site. No theme is the safe
    // reading: the site renders what it rendered before themes existed.
    return '';
  }
}

function toRow(row: ThemeJoin, activeKey: string): ThemeRow {
  return {
    id: row.id,
    key: row.theme_key,
    name: row.name,
    cssSha: row.css_sha256,
    css: row.css,
    bytes: row.bytes,
    sourceName: row.source_name,
    createdAt: row.created_at,
    assetCount: row.asset_count,
    assetBytes: row.asset_bytes,
    active: row.theme_key === activeKey,
  };
}

const SELECT = `SELECT t.id, t.theme_key, t.name, t.css_sha256, b.css, b.bytes, t.source_name, t.created_at,
                       (SELECT COUNT(*) FROM cms_theme_asset a WHERE a.theme_id = t.id) AS asset_count,
                       (SELECT COALESCE(SUM(a.bytes), 0) FROM cms_theme_asset a WHERE a.theme_id = t.id) AS asset_bytes
                  FROM cms_theme t JOIN cms_css_blob b ON b.sha256 = t.css_sha256`;

export function listThemes(db: Database.Database): ThemeRow[] {
  const activeKey = activeThemeKey(db);
  const rows = db.prepare(`${SELECT} ORDER BY t.created_at DESC, t.id DESC`).all() as ThemeJoin[];
  return rows.map((row) => toRow(row, activeKey));
}

export function themeByKey(db: Database.Database, key: string): ThemeRow | undefined {
  const row = db.prepare(`${SELECT} WHERE t.theme_key = ?`).get(key) as ThemeJoin | undefined;
  return row === undefined ? undefined : toRow(row, activeThemeKey(db));
}

/** The active theme, or `null` when the pointer names nothing that exists. */
export function activeTheme(db: Database.Database): ThemeRow | null {
  const key = activeThemeKey(db);
  if (key === '') return null;
  return themeByKey(db, key) ?? null;
}

/**
 * A theme key from a filename: lowercase, `[a-z0-9-]`, no runs, no edges. The CHECK in the schema
 * is the second lock; this is the one that produces a value a person can read in a URL.
 */
export function themeKeyFrom(name: string, taken: (key: string) => boolean): string {
  const base =
    name
      .replace(/\.[a-z0-9]+$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'theme';
  const stem = base.length === 1 ? `${base}-theme` : base;
  if (!taken(stem)) return stem;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  throw new AppError('SKW_E_PL_REJECTED', 'no free theme key for that name');
}

/** What a stylesheet may not contain. Served as `text/css`, neither is executable — both are bugs. */
function refuseMarkup(css: string, name: string): void {
  if (/<\/style/i.test(css)) {
    throw new AppError('SKW_E_PL_REJECTED', `${name} contains a closing style tag — a stylesheet cannot carry one`, { name });
  }
  if (/<script/i.test(css)) {
    throw new AppError('SKW_E_PL_REJECTED', `${name} contains a script tag — a stylesheet cannot carry one`, { name });
  }
}

export interface UploadThemeInput {
  name: string;
  css: string;
  sourceName?: string;
  actorId: number | null;
  /** The files the package carried. Empty for a bare `.css` upload. */
  assets?: readonly ThemeAsset[];
  /** Absolute directory for the tenant's theme files. Required when `assets` is non-empty. */
  assetsRoot?: string;
  /**
   * The key this theme must be stored under, when the caller already owns one.
   *
   * An upload has only a name, so the key is derived from it ("Fractional Works" →
   * `fractional-works`). A *package* carries its key, and a package that changes key when it
   * crosses a box is no longer the same theme: its stylesheet already points at
   * `/_theme/<key>/…` URLs and every exported manifest names it. So a package install passes the
   * key it carries, and a collision with different bytes is refused rather than silently
   * re-keyed — the caller decides `--replace`, not this function.
   */
  key?: string;
}

/**
 * Store an uploaded theme. The row and its blob land in one transaction: a theme whose CSS is
 * missing would be a row that renders as an unstyled site, which is worse than a refused upload.
 */
export function uploadTheme(db: Database.Database, input: UploadThemeInput): ThemeRow {
  const assets = input.assets ?? [];
  const bytes = Buffer.byteLength(input.css, 'utf8');
  if (bytes === 0) throw new AppError('SKW_E_PL_REJECTED', `${input.name} is empty`);
  if (bytes > THEME_MAX_BYTES) {
    throw new AppError('SKW_E_PL_REJECTED', `${input.name} is ${bytes} bytes; the limit is ${THEME_MAX_BYTES}`, { bytes });
  }
  refuseMarkup(input.css, input.name);
  if (assets.length > 0 && input.assetsRoot === undefined) {
    // A programming error, not an operator one: the caller read a package and forgot where its
    // files go. Refusing beats storing rows for bytes nobody wrote.
    throw new AppError('SKW_E_PL_INTERNAL', 'a theme package needs somewhere to put its files');
  }
  const name = input.name.trim().slice(0, 120) || 'Untitled theme';
  const key = input.key ?? themeKeyFrom(name, (candidate) => {
    const hit = db.prepare(`SELECT 1 FROM cms_theme WHERE theme_key = ?`).get(candidate);
    return hit !== undefined;
  });
  if (input.key !== undefined) {
    // The caller owns the key, so this function may not invent or adapt one: a theme stored under
    // a second key would be the same look twice, with the stylesheet pointing at the first.
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.key)) {
      throw new AppError('SKW_E_EXP_THEME_KEY', `"${input.key}" is not a theme key`, { key: input.key });
    }
    const existing = db.prepare(`SELECT css_sha256 FROM cms_theme WHERE theme_key = ?`).get(input.key) as
      | { css_sha256: string }
      | undefined;
    if (existing !== undefined) {
      const incoming = sha256(rewriteAssetUrls(input.css, key, assets));
      if (existing.css_sha256 !== incoming) {
        throw new AppError('SKW_E_EXP_THEME_DIGEST', `theme ${input.key} already exists with different bytes`, {
          key: input.key,
          existing: existing.css_sha256,
          incoming,
        });
      }
    }
  }

  // The sheet is stored *after* the rewrite, so the blob is the exact bytes the browser gets and
  // its sha is therefore its name. The key has to exist before the rewrite, which is why it is
  // allocated above rather than by the INSERT.
  const css = rewriteAssetUrls(input.css, key, assets);
  const root = input.assetsRoot;

  if (root !== undefined && assets.length > 0) {
    const dir = themeAssetDir(root, key);
    try {
      for (const asset of assets) {
        const target = join(dir, asset.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, asset.bytes);
      }
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw new AppError('SKW_E_PLT_INTERNAL', `the theme's files could not be written: ${(err as Error).message}`);
    }
  }

  let id: number;
  try {
    const write = db.transaction(() => {
      const sha = putCssBlob(db, css);
      const result = db
        .prepare(
          `INSERT INTO cms_theme (theme_key, name, css_sha256, source_name, created_by)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(key, name, sha, input.sourceName ?? null, input.actorId);
      const themeId = Number(result.lastInsertRowid);
      const insertAsset = db.prepare(
        `INSERT INTO cms_theme_asset (theme_id, path, sha256, bytes, content_type) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const asset of assets) {
        insertAsset.run(themeId, asset.path, asset.sha256, asset.bytes.length, asset.contentType);
      }
      return themeId;
    });
    id = write();
  } catch (err) {
    // The row is the record; files without a row are unreachable, so they go.
    if (root !== undefined) rmSync(themeAssetDir(root, key), { recursive: true, force: true });
    throw err;
  }

  const row = themeByKey(db, key);
  if (row === undefined || row.id !== id) {
    throw new AppError('SKW_E_PL_INTERNAL', 'the theme was written but cannot be read back', { key });
  }
  return row;
}

/**
 * One file of one theme, by the path the stylesheet names.
 *
 * The lookup is by theme key and path — not by a filesystem path the request supplied — so a URL
 * can only name a file this table says exists. `/_theme/<key>/../../etc/passwd` finds no row.
 */
export function themeAsset(db: Database.Database, themeKey: string, path: string): ThemeAssetRow | undefined {
  const row = db
    .prepare(
      `SELECT a.path, a.sha256, a.bytes, a.content_type
         FROM cms_theme_asset a JOIN cms_theme t ON t.id = a.theme_id
        WHERE t.theme_key = ? AND a.path = ?`,
    )
    .get(themeKey, path) as { path: string; sha256: string; bytes: number; content_type: string } | undefined;
  if (row === undefined) return undefined;
  return { path: row.path, sha256: row.sha256, bytes: row.bytes, contentType: row.content_type };
}

/** Every file of one theme, for the export that has to write them. */
export function themeAssets(db: Database.Database, themeKey: string): ThemeAssetRow[] {
  const rows = db
    .prepare(
      `SELECT a.path, a.sha256, a.bytes, a.content_type
         FROM cms_theme_asset a JOIN cms_theme t ON t.id = a.theme_id
        WHERE t.theme_key = ?
        ORDER BY a.path`,
    )
    .all(themeKey) as { path: string; sha256: string; bytes: number; content_type: string }[];
  return rows.map((row) => ({ path: row.path, sha256: row.sha256, bytes: row.bytes, contentType: row.content_type }));
}

/**
 * Point the site at a theme. The settings row is the only thing that changes, so this is also the
 * undo for a bad upload: activate the previous one.
 */
export function activateTheme(db: Database.Database, key: string, actorId: number | null): ThemeRow {
  const theme = themeByKey(db, key);
  if (theme === undefined) throw new AppError('SKW_E_PL_REJECTED', `no theme named ${key}`, { key });
  db.prepare(
    `INSERT INTO cms_settings (key, value_json, type, updated_by) VALUES (?, ?, 'string', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, type = excluded.type,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = excluded.updated_by`,
  ).run(THEME_KEY_SETTING, JSON.stringify(key), actorId);
  return { ...theme, active: true };
}

/** Back to the pasted `site.theme_css` (or to no theme at all, when that is empty too). */
export function deactivateTheme(db: Database.Database, actorId: number | null): void {
  db.prepare(
    `INSERT INTO cms_settings (key, value_json, type, updated_by) VALUES (?, '""', 'string', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = '""', type = 'string',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = excluded.updated_by`,
  ).run(THEME_KEY_SETTING, actorId);
}

/**
 * Delete a theme. The active one is refused: a delete that silently unstyles the live site is
 * the kind of operator mistake a refusal is for. Deactivate first, which is one click and is the
 * moment the operator sees what the site looks like without it.
 */
export function deleteTheme(db: Database.Database, key: string, assetsRoot?: string): void {
  const theme = themeByKey(db, key);
  if (theme === undefined) throw new AppError('SKW_E_PL_REJECTED', `no theme named ${key}`, { key });
  if (theme.active) {
    throw new AppError('SKW_E_PL_REJECTED', `${theme.name} is the active theme — deactivate it first`, { key });
  }
  // The blob is left in place on purpose: another theme, or a page, may share those exact bytes,
  // and a content-addressed file that exists is never wrong. Pruning is a separate job with a
  // reference count, not a side effect of deleting a row. The assets are the opposite: their path
  // is owned by this theme key and by nothing else, so they go with it.
  db.transaction(() => {
    db.prepare(`DELETE FROM cms_theme_asset WHERE theme_id = ?`).run(theme.id);
    db.prepare(`DELETE FROM cms_theme WHERE theme_key = ?`).run(key);
  })();
  if (assetsRoot !== undefined) {
    const dir = themeAssetDir(assetsRoot, key);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
