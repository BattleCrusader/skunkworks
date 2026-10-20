/**
 * §7.1 / D18 / C-17 — the **public symlink farm**, and the one thing it may not contain.
 *
 * `content/public/` holds exactly one *relative* symlink per public asset:
 *
 *     content/public/<key>.<ext>  ->  ../media/<hh>/<sha256>.<ext>
 *
 * so `/media/<key>.<ext>` is a directory lookup nginx answers with `try_files` and no Node
 * in the path. Two consequences are the reason the farm exists at all:
 *
 *   1. **A gated asset has no link.** Not a link with a permission check — no link. `/media/
 *      <gated-key>` is then a 404 from the same `try_files` that 404s a key that never
 *      existed, and the two 404s are byte-identical because they are the same response.
 *      §7.1's link-absence test (`find content/public -lname "*<gated sha>*"` empty) is the
 *      witness, and `linksPointingAt()` below is the code that makes that `find` unnecessary
 *      to guess at.
 *   2. **The link name is the key, and the target is a checksum.** The target is computed
 *      from `cms_asset.storage_path` (itself a generated column), and the name is the key
 *      the schema already constrains to `[a-z0-9/_.-]` with no `..` and no leading dot. So
 *      neither half of a link can be steered at `/etc/passwd` by a form field — the defect
 *      that retired the old "storage_path is row data" design.
 *
 * **Every write is atomic.** A symlink is created under a temporary name in the same
 * directory and published with `renameSync`, which replaces an existing link in one
 * directory operation. A reader either sees the old link or the new one, never a moment with
 * neither — that property is what a rename is tested against by sampling both URLs while it
 * runs.
 *
 * **Rename keeps the old URL alive twice over.** The alias row is the record; the edge needs
 * a 301 it can answer without a database, so the farm also writes a `map` fragment
 * (`content/edge/media-aliases.map`) that `nginx_gen` includes at http scope. A `map` is
 * read when nginx loads its config, so the sequence is: create the new links → rewrite the
 * map → *then* remove the old links. Until the map is live the old link answers with bytes;
 * after it, with a 301. There is no ordering of those three steps in which both URLs are
 * gone.
 */
import type Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { AppError } from '../errors.ts';
import { EXTS, MEDIA_REL_PREFIX } from './store.ts';

/** `content/public/` — the only directory nginx's `/media/` alias resolves against. */
export const PUBLIC_REL_PREFIX = 'content/public/';

/** `content/edge/` — generated nginx fragments (the alias map). Never served. */
export const EDGE_REL_PREFIX = 'content/edge/';

/** The fragment `nginx_gen` includes *inside* its `map` block, at http scope. */
export const ALIAS_MAP_REL = 'content/edge/media-aliases.inc';

/** `content/public/` as an absolute path. */
export function publicDirOf(contentRoot: string): string {
  return join(contentRoot, 'public');
}

export function edgeDirOf(contentRoot: string): string {
  return join(contentRoot, 'edge');
}

/** The mime → extension map the generated `storage_path` column uses, in one place. */
export const EXT_BY_MIME: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'application/zip': 'zip',
};

export function extOfMime(mime: string): string {
  const ext = EXT_BY_MIME[mime];
  if (ext === undefined) throw new AppError('SKW_E_PLT_INTERNAL', 'an asset mime outside the closed set reached the farm', { mime });
  return ext;
}

/**
 * The link name for an asset. `key` is already constrained by `cms_asset.key`'s CHECK
 * (`[a-z0-9/_.-]`, no `..`, no leading dot); this asserts it again because the farm is the
 * one place a key becomes a *path*, and a second reader of the rule that cannot disagree is
 * cheaper than trusting the first.
 */
export function linkName(key: string, ext: string): string {
  return `${assertKey(key)}.${assertExt(ext)}`;
}

/**
 * A rendition's link: `<key>@<label>.<format>`.
 *
 * `@` is deliberate: `cms_asset.key` cannot contain it (`key NOT GLOB '*[^a-z0-9/_.-]*'`), so
 * a variant name can never collide with an asset key, and `assetRefsInHtml` (which is what
 * writes link rows for `body_html`) cannot mistake one for a page reference.
 */
export function variantLinkName(key: string, label: string, format: string): string {
  if (!['thumb', 'md', 'lg', 'og'].includes(label)) {
    throw new AppError('SKW_E_PLT_INTERNAL', 'not a variant label', { label });
  }
  return `${assertKey(key)}@${label}.${assertExt(format === 'jpeg' ? 'jpg' : format)}`;
}

function assertKey(key: string): string {
  if (key.length < 1 || key.length > 96) throw new AppError('SKW_E_PLT_INTERNAL', 'not an asset key', { key });
  if (!/^[a-z0-9][a-z0-9/_.-]*$/.test(key) || key.includes('..') || key.endsWith('/')) {
    throw new AppError('SKW_E_PLT_INTERNAL', 'not an asset key', { key });
  }
  return key;
}

function assertExt(ext: string): string {
  if (!EXTS.has(ext)) throw new AppError('SKW_E_PLT_INTERNAL', 'not a stored extension', { ext });
  return ext;
}

/**
 * `content/media/hh/<sha>.<ext>` → `../media/hh/<sha>.<ext>`, with one `../` per directory the
 * link itself sits in (a key may contain `/`, so `banner/home.png` is two levels down and needs
 * `../../`).
 *
 * The target is **relative** so the tree can be mounted at a different path (the bundle
 * exporter and the test harness both do) without rewriting a single link, and so a link
 * cannot name an absolute path even if the row were somehow forged.
 */
export function linkTargetOf(storagePath: string, depth = 1): string {
  if (!storagePath.startsWith(MEDIA_REL_PREFIX)) {
    throw new AppError('SKW_E_PLT_INTERNAL', 'a farm target must be under content/media/', { storage_path: storagePath });
  }
  const rest = storagePath.slice('content/'.length);
  if (!/^media\/[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]+$/.test(rest) || rest.includes('..')) {
    throw new AppError('SKW_E_PLT_INTERNAL', 'a farm target is not a media path', { storage_path: storagePath });
  }
  return `${'../'.repeat(Math.max(1, depth))}${rest}`;
}

// --- the rows the farm reads -------------------------------------------------------------

interface FarmRow {
  id: number;
  key: string;
  mime: string;
  sha256: string;
  access_class: 'public' | 'linked-private' | 'gated';
  storage_path: string;
}

interface VariantRow {
  label: string;
  format: string;
  storage_path: string;
}

function farmRow(db: Database.Database, key: string): FarmRow | undefined {
  return db
    .prepare('SELECT id, key, mime, sha256, access_class, storage_path FROM cms_asset WHERE key = ?')
    .get(key) as FarmRow | undefined;
}

function variantsOf(db: Database.Database, assetId: number): VariantRow[] {
  return db
    .prepare('SELECT label, format, storage_path FROM cms_asset_variant WHERE asset_id = ? ORDER BY label, format')
    .all(assetId) as VariantRow[];
}

/** Every link a public asset *would* have: the blob, then one per rendition. */
export function wantedLinks(row: FarmRow, variants: readonly VariantRow[]): { name: string; target: string }[] {
  const ext = extOfMime(row.mime);
  const withTarget = (name: string, storagePath: string): { name: string; target: string } => ({
    name,
    // The target is relative to the link's own directory, so a nested key needs one `../` per
    // level it sits below `public/`.
    target: linkTargetOf(storagePath, name.split('/').length),
  });
  const out = [withTarget(linkName(row.key, ext), row.storage_path)];
  for (const variant of variants) {
    out.push(withTarget(variantLinkName(row.key, variant.label, variant.format), variant.storage_path));
  }
  return out;
}

// --- the atomic symlink ------------------------------------------------------------------

/**
 * Publish one symlink atomically: create it under a temporary name in the same directory,
 * then `renameSync` it onto the final name.
 *
 * `renameSync` replaces an existing symlink in a single directory operation — there is no
 * window in which the name is absent, which `unlink` + `symlink` would have and which a
 * concurrent reader would see as a 404 for an asset that exists.
 */
function publishLink(dir: string, name: string, target: string): void {
  const finalPath = join(dir, name);
  // A key may contain `/` (the schema allows it and §7.1's URL is `<key>.<ext>`), so a link can
  // nest. The directory is created, never assumed.
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmp = join(dirname(finalPath), `.tmp-link-${randomUUID()}`);
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, finalPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Every symlink under `dir`, as a path relative to it. Nested keys are links in subdirs. */
function listLinks(dir: string, prefix = ''): { name: string; target: string }[] {
  let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
  try {
    entries = readdirSync(join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string; target: string }[] = [];
  for (const entry of entries) {
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const abs = join(dir, name);
    try {
      if (entry.isSymbolicLink()) out.push({ name, target: readlinkSync(abs) });
      else if (entry.isDirectory()) out.push(...listLinks(dir, name));
    } catch {
      /* vanished between readdir and readlink */
    }
  }
  return out;
}

/** Remove the links whose name starts with `<key>.` or `<key>@` — by name, not by row. */
function removeLinks(dir: string, key: string): string[] {
  const removed: string[] = [];
  for (const link of listLinks(dir)) {
    if (!(link.name.startsWith(`${key}.`) || link.name.startsWith(`${key}@`))) continue;
    // Only ever a symlink: a real file in the public tree is not the farm's to delete, and
    // deleting one would be a wider permission than this module was given.
    try {
      rmSync(join(dir, link.name), { force: true });
      removed.push(link.name);
    } catch {
      /* raced with another writer: the name is gone, which is the postcondition */
    }
  }
  return removed;
}

export interface SyncResult {
  created: string[];
  removed: string[];
  /** True when the asset is gated and therefore has no link at all. */
  gated: boolean;
}

/**
 * Make the farm agree with the row for `key`: a link for a public asset, **nothing at all**
 * for a gated one.
 *
 * `linked-private` is treated like `public` here on purpose: §7.2's three classes are about
 * *how a byte is reached*, and 'linked-private' means "public URL, unguessable key" — the
 * download plane's own codes never depend on it. Only `gated` is structurally absent, which
 * is the distinction F1 rests on.
 */
export function syncAssetLinks(db: Database.Database, contentRoot: string, key: string): SyncResult {
  const dir = publicDirOf(contentRoot);
  const row = farmRow(db, key);
  if (row === undefined) return { created: [], removed: removeLinks(dir, key), gated: false };
  if (row.access_class === 'gated') {
    // Remove *before* refusing to create: a row that was public and became gated must lose
    // its link in the same call, or the 404 the design promises is a stale 200.
    return { created: [], removed: removeLinks(dir, key), gated: true };
  }
  const links = wantedLinks(row, variantsOf(db, row.id));
  const wanted = new Set(links.map((link) => link.name));
  for (const link of links) publishLink(dir, link.name, link.target);
  // A rendition that was dropped (a format removed from the plan) must not keep a link.
  return { created: [...wanted], removed: removeUnwanted(dir, key, wanted), gated: false };
}

/** Delete this key's links except the names in `keep`. */
function removeUnwanted(dir: string, key: string, keep: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const link of listLinks(dir)) {
    const mine = link.name.startsWith(`${key}.`) || link.name.startsWith(`${key}@`);
    if (!mine || keep.has(link.name)) continue;
    try {
      rmSync(join(dir, link.name), { force: true });
      removed.push(link.name);
    } catch {
      /* raced: gone is the postcondition */
    }
  }
  return removed;
}

/** Delete an asset's links. Used by `deleteAsset`, and by `syncAssetLinks` when the row is gone. */
export function removeAssetLinks(contentRoot: string, key: string): string[] {
  return removeLinks(publicDirOf(contentRoot), key);
}

// --- the alias map, which is how a renamed key 301s at the edge --------------------------

/**
 * The generated fragment — **map entries only**, because it is included *inside* the `map`
 * block `nginx_gen` emits:
 *
 *     /media/old.png /media/new.png?v=1a2b3c4d;
 *
 * `map` is http-scope only, which is why the block lives in `10-app.conf` and this file is
 * an include rather than a complete directive. Keeping the block in the generator and the
 * entries here is what makes a fresh box (no renames, no file) start: the variable is
 * declared by the block, and a glob include that matches nothing is not an error in nginx.
 *
 * The target carries `?v=<sha8>` rather than `$is_args$args`: a renamed key must land on a
 * cache-busting URL, and appending the caller's arguments to a URL that already has a query
 * would produce `/media/new.png?v=…?utm=x`.
 */
export function aliasMapText(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT a.key AS old_key, s.key AS new_key, s.mime AS mime, s.sha256 AS sha256
         FROM cms_asset_alias a JOIN cms_asset s ON s.id = a.asset_id
        ORDER BY a.key`,
    )
    .all() as { old_key: string; new_key: string; mime: string; sha256: string }[];
  const lines = [
    '# GENERATED by app/assets/farm.ts from cms_asset_alias — do not edit by hand.',
    '# Included inside `map $uri $skw_media_alias` in the file tools/nginx_gen.ts emits.',
    '# A 301 here is the edge answering a renamed key without a database.',
  ];
  for (const row of rows) {
    const ext = extOfMime(row.mime);
    lines.push(`/media/${row.old_key}.${ext} /media/${row.new_key}.${ext}?v=${row.sha256.slice(0, 8)};`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Write the fragment atomically. A missing file is fine for nginx (`*.inc` glob include). */
export function writeAliasMap(db: Database.Database, contentRoot: string): string {
  const path = join(edgeDirOf(contentRoot), 'media-aliases.inc');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, aliasMapText(db), 'utf8');
  renameSync(tmp, path);
  return path;
}

// --- the whole-tree rebuild --------------------------------------------------------------

export interface RebuildReport {
  created: number;
  removed: number;
  /** Links that exist in `content/public` and that no row asked for. */
  orphans: string[];
  gated_with_links: string[];
}

/**
 * Rebuild the farm from the rows. Creation/rename/delete maintain it incrementally
 * (`syncAssetLinks`); this is the repair path and the bundle-export path, and it is what the
 * link-absence test runs against a real tree:
 *
 *   - a wanted link that is missing is created;
 *   - an entry nobody asked for is removed **only if it is a symlink** — a file a human put
 *     in `content/public` is reported, not deleted;
 *   - a gated asset with a link is reported by key before the link is removed, so a
 *     regression is loud rather than silently cleaned up.
 */
export function rebuildFarm(db: Database.Database, contentRoot: string): RebuildReport {
  const dir = publicDirOf(contentRoot);
  mkdirSync(dir, { recursive: true });
  const assets = db
    .prepare('SELECT id, key, mime, sha256, access_class, storage_path FROM cms_asset ORDER BY key')
    .all() as FarmRow[];

  const wanted = new Map<string, string>();
  const gatedWithLinks: string[] = [];
  const gatedKeys = new Set<string>();
  for (const row of assets) {
    if (row.access_class === 'gated') {
      gatedKeys.add(row.key);
      continue;
    }
    for (const link of wantedLinks(row, variantsOf(db, row.id))) wanted.set(link.name, link.target);
  }

  const existing = new Map<string, string>();
  for (const link of listLinks(dir)) existing.set(link.name, link.target);

  const orphans: string[] = [];
  for (const [name, target] of existing) {
    if (wanted.get(name) === target) continue;
    if (gatedKeys.has(name.replace(/[.@].*$/, ''))) gatedWithLinks.push(name);
    rmSync(join(dir, name), { force: true });
    orphans.push(name);
  }
  let created = 0;
  for (const [name, target] of wanted) {
    if (existing.get(name) === target) continue;
    publishLink(dir, name, target);
    created += 1;
  }
  writeAliasMap(db, contentRoot);
  return { created, removed: orphans.length, orphans, gated_with_links: gatedWithLinks };
}

/**
 * The `find content/public -lname "*<sha>*"` of §7.1, in code: every link whose target names
 * this checksum. The link-absence test for a gated asset is `length === 0`, and it is a
 * stronger statement than "the key 404s" because it covers the alias and variant names too.
 */
export function linksPointingAt(contentRoot: string, sha256: string): string[] {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new AppError('SKW_E_PLT_INTERNAL', 'not a sha256');
  return listLinks(publicDirOf(contentRoot))
    .filter((link) => link.target.includes(sha256))
    .map((link) => link.name)
    .sort();
}
