/**
 * §7.1's derived bytes: `cms_asset_variant`, one row per (asset, label, format).
 *
 * **Why the rows exist at all.** `srcset` needs to state a width for every candidate, and a
 * width that is guessed rather than measured is a lie the browser acts on. So the derive
 * step records the real `width`, `height`, byte count and checksum of each encode, and
 * `site.asset()` reads its `srcset` from those rows (never from a constant table in code).
 *
 * **Determinism is a testable property, not a hope.** The encoder is called with explicit
 * flags and no metadata, from the *stored* bytes (which S3a already re-encoded once), so the
 * same asset yields byte-identical renditions on every run — asserted by hashing the output
 * of two independent derive calls, and by comparing against the sha recorded in the row.
 *
 * **A variant blob is content-addressed like any other byte.** It is written through
 * `putBytes`, so `content/media/<hh>/<vsha>.<ext>` dedupes across assets that happen to
 * produce the same encode, and it inherits the store's exclusive-publish rule. The
 * `storage_path` column stays a plain column (the DDL says why: it is the only record of
 * which variant files exist), and this module is its only writer.
 */
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

import sharp from 'sharp';

import { AppError } from '../errors.ts';
import { syncAssetLinks } from './farm.ts';
import { pathUnder, putBytes } from './store.ts';
import { sha256OfStored } from './sniff.ts';

export type Label = 'thumb' | 'md' | 'lg' | 'og';
export type Format = 'webp' | 'avif';

/** The label widths. `og` is a cover crop because a 1.91:1 card is what the tag promises. */
export const LABELS: readonly { label: Label; width: number; height: number | null; fit: 'inside' | 'cover' }[] = [
  { label: 'thumb', width: 320, height: null, fit: 'inside' },
  { label: 'md', width: 768, height: null, fit: 'inside' },
  { label: 'lg', width: 1280, height: null, fit: 'inside' },
  { label: 'og', width: 1200, height: 630, fit: 'cover' },
];

/** Two formats, not four: v1 ships what the browsers it targets can decode. */
export const FORMATS: readonly Format[] = ['webp', 'avif'];

export interface PlannedVariant {
  label: Label;
  format: Format;
  width: number;
  height: number;
  bytes: Buffer;
  sha256: string;
  /** `content/media/hh/<sha>.<ext>`, as stored in `cms_asset_variant.storage_path`. */
  storagePath: string;
  ext: string;
}

/**
 * Encode every (label, format) from the stored bytes — in memory, nothing written.
 *
 * `withoutEnlargement` is load-bearing: a 500 px source must not be served as a "1280w"
 * candidate, because the browser would pick it on a large screen and get a blurry upscale.
 * The row records the width actually produced, so `srcset` and the pixels agree.
 */
export async function planVariants(bytes: Buffer): Promise<PlannedVariant[]> {
  const out: PlannedVariant[] = [];
  for (const spec of LABELS) {
    for (const format of FORMATS) {
      const pipeline = sharp(bytes, { failOn: 'error' }).resize({
        width: spec.width,
        ...(spec.height === null ? {} : { height: spec.height }),
        fit: spec.fit,
        withoutEnlargement: true,
      });
      const encoded =
        format === 'webp'
          ? await pipeline.webp({ quality: 80, effort: 4 }).toBuffer()
          : await pipeline.avif({ quality: 55, effort: 4 }).toBuffer();
      const meta = await sharp(encoded).metadata();
      if (meta.width === undefined || meta.height === undefined) {
        throw new AppError('SKW_E_PLT_INTERNAL', 'a rendition has no dimensions');
      }
      const sha256 = sha256OfStored(encoded);
      out.push({
        label: spec.label,
        format,
        width: meta.width,
        height: meta.height,
        bytes: encoded,
        sha256,
        storagePath: `content/media/${sha256.slice(0, 2)}/${sha256}.${format}`,
        ext: format,
      });
    }
  }
  return out;
}

export interface VariantRecord {
  id: number;
  asset_id: number;
  label: Label;
  format: Format;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  storage_path: string;
}

export function variantsForAsset(db: Database.Database, assetId: number): VariantRecord[] {
  return db
    .prepare(
      `SELECT id, asset_id, label, format, width, height, bytes, sha256, storage_path
         FROM cms_asset_variant WHERE asset_id = ? ORDER BY width, label, format`,
    )
    .all(assetId) as VariantRecord[];
}

interface AssetImageRow {
  id: number;
  key: string;
  kind: string;
  access_class: string;
  mime: string;
  sha256: string;
  storage_path: string;
}

/**
 * Derive, store and record the renditions for one asset. Idempotent: a second call with the
 * same input writes the same blobs (dedupe) and the same rows (`ON CONFLICT DO UPDATE`), so
 * "regenerate" is safe to run after a deploy.
 *
 * A non-image yields no variants and no rows — a PDF has no `thumb`, and inventing one would
 * mean rasterising a document nobody asked to rasterise.
 */
export async function ensureVariants(opts: {
  db: Database.Database;
  contentRoot: string;
  assetId: number;
}): Promise<VariantRecord[]> {
  const asset = opts.db
    .prepare('SELECT id, key, kind, access_class, mime, sha256, storage_path FROM cms_asset WHERE id = ?')
    .get(opts.assetId) as AssetImageRow | undefined;
  if (asset === undefined) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such asset', { id: opts.assetId });
  if (asset.kind !== 'image') return variantsForAsset(opts.db, asset.id);

  const source = readFileSync(pathUnder(opts.contentRoot, asset.storage_path));
  const planned = await planVariants(source);

  const upsert = opts.db.prepare(
    `INSERT INTO cms_asset_variant (asset_id, label, format, width, height, bytes, sha256, storage_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_id, label, format) DO UPDATE SET
       width = excluded.width, height = excluded.height, bytes = excluded.bytes,
       sha256 = excluded.sha256, storage_path = excluded.storage_path`,
  );
  const run = opts.db.transaction((): void => {
    for (const variant of planned) {
      putBytes({ contentRoot: opts.contentRoot, sha256: variant.sha256, bytes: variant.bytes, ext: variant.ext });
      upsert.run(
        asset.id,
        variant.label,
        variant.format,
        variant.width,
        variant.height,
        variant.bytes.length,
        variant.sha256,
        variant.storagePath,
      );
    }
  });
  run();
  // §7.1: a rendition is public only if the *farm* names it, so the module that creates the
  // rows is the module that publishes the links. Without this call a variant row exists and
  // `srcset` advertises a URL nginx would 404 — the exact mismatch R3/R4 are meant to catch.
  syncAssetLinks(opts.db, opts.contentRoot, asset.key);
  return variantsForAsset(opts.db, asset.id);
}
