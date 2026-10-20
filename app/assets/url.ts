/**
 * §7.3 / D17 — `site.asset('key')`: the resolver that turns a **key** into the five things a
 * template is allowed to know about an asset, and nothing else.
 *
 *     site.asset('banner-home')
 *       -> { url, srcset, width, height, alt }
 *
 * **Content never stores the URL.** A page body, a datasource row and a `cms_nav.href_target`
 * all carry the key; the URL is built here, every render, from the row. That is what makes a
 * rename a one-row change instead of a rewrite of every body that mentions the asset, and it
 * is why `?v=` can be derived from the checksum rather than remembered in content.
 *
 * **The shape of the URL is the farm's name, not a second naming scheme.** `url` is
 * `/media/<key>.<ext>?v=<sha8>` — exactly the file `farm.ts` published a symlink for, with a
 * cache-busting suffix that changes when the bytes change and does **not** change when only
 * the key is renamed (the checksum is the address; the key is identity).
 *
 * **`srcset` is read from the variant rows.** Each candidate is
 * `/media/<key>@<label>.<format>?v=<variant sha8> <width>w`, and the width is the width that
 * row recorded. A hard-coded table here would drift from the pixels the moment a label's
 * width changed, and the browser would choose a candidate by a number nothing measured.
 *
 * **A gated asset has no URL to build.** Its farm link does not exist, so a URL would be a
 * 404 dressed as a resource. `url` is `null` and `srcset` is empty: the template can render
 * the alt text and the dimensions, and cannot accidentally publish paid bytes by writing
 * `src={asset.url}` — there is nothing to write.
 */
import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import { assetByKey, type AssetRow } from './library.ts';
import { extOfMime, linkName, variantLinkName } from './farm.ts';
import { variantsForAsset, type VariantRecord } from './renditions.ts';

export interface SiteAsset {
  /** `/media/<key>.<ext>?v=<sha8>`, or null for a gated asset (no farm link exists). */
  url: string | null;
  /** `"<url> <width>w"` per variant row, widest last; empty for a gated asset or a document. */
  srcset: string;
  width: number | null;
  height: number | null;
  alt: string;
}

/** The eight characters a cache-buster needs to change when the bytes change. */
export function versionOf(sha256: string): string {
  return sha256.slice(0, 8);
}

export function assetUrl(row: Pick<AssetRow, 'key' | 'mime' | 'sha256'>): string {
  return `/media/${linkName(row.key, extOfMime(row.mime))}?v=${versionOf(row.sha256)}`;
}

export function variantUrl(row: Pick<AssetRow, 'key'>, variant: Pick<VariantRecord, 'label' | 'format' | 'sha256'>): string {
  return `/media/${variantLinkName(row.key, variant.label, variant.format)}?v=${versionOf(variant.sha256)}`;
}

/** `"a.webp 320w, b.webp 768w"` — ascending width, which is the order browsers prefer. */
export function srcsetOf(row: Pick<AssetRow, 'key'>, variants: readonly VariantRecord[]): string {
  return [...variants]
    .sort((a, b) => a.width - b.width || a.format.localeCompare(b.format))
    .map((variant) => `${variantUrl(row, variant)} ${variant.width}w`)
    .join(', ');
}

/**
 * Resolve a key (or an old key, through `cms_asset_alias`) to the render-time asset.
 *
 * The URL always names the **live** key: after a rename the farm link is the new one, and the
 * old key is a 301 at the edge. Building the old URL here would send every reader through a
 * redirect for a row the renderer already has in hand.
 */
export function siteAsset(db: Database.Database, key: string): SiteAsset {
  const row = assetByKey(db, key) ?? assetByAlias(db, key);
  if (row === undefined) {
    throw new AppError('SKW_E_RT_SOURCE_UNKNOWN', 'no asset with that key', { key, reason: 'asset_unknown' });
  }
  const base = {
    width: row.width,
    height: row.height,
    alt: row.alt_text ?? '',
  };
  if (row.access_class === 'gated') return { url: null, srcset: '', ...base };
  const variants = row.kind === 'image' ? variantsForAsset(db, row.id) : [];
  return { url: assetUrl(row), srcset: srcsetOf(row, variants), ...base };
}

function assetByAlias(db: Database.Database, key: string): AssetRow | undefined {
  const alias = db.prepare('SELECT asset_id FROM cms_asset_alias WHERE key = ?').get(key) as
    | { asset_id: number }
    | undefined;
  if (alias === undefined) return undefined;
  return db
    .prepare(
      `SELECT id, key, filename, mime, bytes, sha256, kind, access_class, storage_path, width, height,
              alt_text, caption, encrypted, watermark_asset_id, frozen_at, created_at, created_by
         FROM cms_asset WHERE id = ?`,
    )
    .get(alias.asset_id) as AssetRow | undefined;
}
