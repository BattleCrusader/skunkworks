/**
 * §7.1 / D17 — the asset **row**: identity is the key, the checksum is only the address.
 *
 * Four rules live here, and each one is a refusal rather than a convention:
 *
 *   - **key is identity.** Content stores `banner-home`, never a path and never a hash. Two
 *     uploads of the same bytes under two keys are two assets that share one blob: dedupe is
 *     physical (D13), identity is the key (D17). Re-posting the *same* key and the same
 *     bytes is reported as `reused: true` — an explicit answer, because a silent no-op is
 *     indistinguishable from a successful write to the caller.
 *   - **a key's bytes never change.** Re-uploading different bytes under an existing key is
 *     `409 SKW_E_DM_COLUMN_IMMUTABLE`, which is the same code the schema's
 *     `trg_cms_asset_sha_immutable` raises — the app refuses before the trigger has to, and
 *     the trigger is the backstop for every other writer.
 *   - **a referenced key cannot be renamed** (`409 SKW_E_DM_KEY_IN_USE`, naming the count).
 *     An unreferenced rename writes one `cms_asset_alias` row and moves no bytes.
 *   - **a linked asset cannot be deleted** (`409 SKW_E_DM_ASSET_IN_USE`). The schema's
 *     `trg_cms_asset_delete_guard` refuses it too, so a raw `DELETE` from the `sqlite3` CLI
 *     gets the same verdict; the app's job is to name the count first.
 */
import type Database from 'better-sqlite3';
import { basename, extname } from 'node:path';

import { AppError } from '../errors.ts';
import { resolveAssetId, linksForAsset } from './links.ts';
import { putBytes, quotaState, usedBytes, type QuotaState } from './store.ts';
import { sha256OfStored, sniffAndNormalise, type AssetKind } from './sniff.ts';

export interface AssetRow {
  id: number;
  key: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  kind: AssetKind;
  access_class: 'public' | 'linked-private' | 'gated';
  storage_path: string;
  width: number | null;
  height: number | null;
  alt_text: string | null;
  caption: string | null;
  encrypted: number;
  watermark_asset_id: number | null;
  frozen_at: string | null;
  created_at: string;
  created_by: number | null;
}

export const ASSET_COLUMNS =
  'id, key, filename, mime, bytes, sha256, kind, access_class, storage_path, width, height, alt_text, caption, encrypted, watermark_asset_id, frozen_at, created_at, created_by';

export function assetByKey(db: Database.Database, key: string): AssetRow | undefined {
  return db.prepare(`SELECT ${ASSET_COLUMNS} FROM cms_asset WHERE key = ?`).get(key) as AssetRow | undefined;
}

export function assetById(db: Database.Database, id: number): AssetRow | undefined {
  return db.prepare(`SELECT ${ASSET_COLUMNS} FROM cms_asset WHERE id = ?`).get(id) as AssetRow | undefined;
}

/**
 * The key a URL names, resolved through the alias table: `/media/old-name.png` still reaches
 * the asset after an unreferenced rename. Defined in `links.ts` because the graph needs it and
 * a two-way import between the row module and the graph is a cycle with no benefit.
 */
export { resolveAssetId };

/**
 * A filename is display data. It is still validated, because it is the one string an
 * uploader fully controls and every place it could be read as a path must fail closed:
 * separators, control characters, a leading dot and anything over 200 characters are refused
 * rather than sanitised (a sanitised name is a different name, silently).
 */
export function assertFilename(filename: string): string {
  const refused = (): never => {
    throw new AppError('SKW_E_SEC_UPLOAD_REJECTED', 'the filename is not a display name', {
      reason: 'filename_invalid',
    });
  };
  if (filename.length === 0 || filename.length > 200) refused();
  if (filename !== basename(filename)) refused();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f/\\]/.test(filename)) refused();
  if (filename.startsWith('.')) refused();
  if (extname(filename) === '') refused();
  return filename;
}

export interface UploadInput {
  db: Database.Database;
  contentRoot: string;
  tenantKey: string;
  key: string;
  filename: string;
  bytes: Buffer;
  /** The tenant's `storage_quota_bytes` (control.db). Enforced before the write. */
  quotaLimitBytes: number;
  accessClass?: 'public' | 'linked-private' | 'gated';
  altText?: string | null;
  caption?: string | null;
  declaredMime?: string;
  maxBytes?: number;
  createdBy?: number | null;
}

export interface UploadResult {
  asset: AssetRow;
  /** Same key, same bytes: the existing row, and the caller is told so. */
  reused: boolean;
  /** False when the blob already existed — a dedupe, or a second key over one blob. */
  wroteFile: boolean;
  relPath: string;
}

/**
 * Upload: sniff → checksum → (existing key?) → quota → write → row.
 *
 * The checksum is taken **after** the sniff, because the stored bytes of an image are the
 * re-encode. A checksum of the upload would address bytes that are not on disk, which is the
 * one thing a content-addressed store may not do.
 */
export async function uploadAsset(input: UploadInput): Promise<UploadResult> {
  const filename = assertFilename(input.filename);
  const sniffed = await sniffAndNormalise({
    filename,
    bytes: input.bytes,
    ...(input.declaredMime === undefined ? {} : { declaredMime: input.declaredMime }),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  });
  const sha256 = sha256OfStored(sniffed.bytes);

  const existing = assetByKey(input.db, input.key);
  if (existing !== undefined) {
    if (existing.sha256 === sha256) {
      return { asset: existing, reused: true, wroteFile: false, relPath: existing.storage_path };
    }
    throw new AppError('SKW_E_DM_COLUMN_IMMUTABLE', 'this key already holds different bytes; upload under a new key', {
      key: input.key,
      existing_sha: existing.sha256,
      uploaded_sha: sha256,
    });
  }

  const quota: QuotaState = quotaState(input.db, input.quotaLimitBytes);
  const put = putBytes({ contentRoot: input.contentRoot, sha256, bytes: sniffed.bytes, ext: sniffed.ext, quota });

  const info = input.db
    .prepare(
      `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, access_class, width, height, alt_text, caption, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.key,
      filename,
      sniffed.mime,
      sniffed.bytes.length,
      sha256,
      sniffed.kind,
      input.accessClass ?? 'public',
      sniffed.width,
      sniffed.height,
      input.altText ?? null,
      input.caption ?? null,
      input.createdBy ?? null,
    );
  const asset = assetById(input.db, Number(info.lastInsertRowid));
  if (asset === undefined) throw new AppError('SKW_E_PLT_INTERNAL', 'the asset row vanished after insert');
  return { asset, reused: false, wroteFile: put.wrote, relPath: put.relPath };
}

export interface RenameResult {
  alias: true;
  links: 0;
  from: string;
  to: string;
}

/**
 * Rename an **unreferenced** key (§7.1). The alias row is what makes the old URL keep working
 * for keys frozen inside `body_html`, which no foreign key can see.
 *
 * `SKW_REPOINT_MAX_ROWS`/the `repoint` operation is S3b: it rewrites up to 5,000 referencing
 * rows in one audited transaction, and it is deliberately not reachable from this function.
 */
export function renameAsset(db: Database.Database, opts: { from: string; to: string }): RenameResult {
  const row = assetByKey(db, opts.from);
  if (row === undefined) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no asset with that key', { key: opts.from });
  }
  const links = linksForAsset(db, row.id);
  if (links.length > 0) {
    throw new AppError('SKW_E_DM_KEY_IN_USE', 'this key is referenced; renaming it would break the references', {
      key: opts.from,
      references: links.length,
      owners: links.slice(0, 10),
    });
  }
  const taken = resolveAssetId(db, opts.to);
  if (taken !== undefined && taken !== row.id) {
    throw new AppError('SKW_E_DM_KEY_IN_USE', 'the target key already names an asset', {
      key: opts.to,
      asset_id: taken,
    });
  }

  const run = db.transaction((): void => {
    try {
      db.prepare('UPDATE cms_asset SET key = ? WHERE id = ?').run(opts.to, row.id);
    } catch (err) {
      // A `u_*` column with `REFERENCES cms_asset(key) ON UPDATE RESTRICT` is the other half
      // of "a referenced key cannot move": the FK refuses an update the link table cannot see.
      if (/FOREIGN KEY constraint failed/i.test((err as Error).message)) {
        throw new AppError('SKW_E_DM_KEY_IN_USE', 'a runtime table still references this key', {
          key: opts.from,
        });
      }
      throw err;
    }
    // The target key must not also be an alias of this asset: one URL, one row.
    db.prepare('DELETE FROM cms_asset_alias WHERE key = ? AND asset_id = ?').run(opts.to, row.id);
    db.prepare(
      `INSERT INTO cms_asset_alias (key, asset_id) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET asset_id = excluded.asset_id`,
    ).run(opts.from, row.id);
  });
  run();
  return { alias: true, links: 0, from: opts.from, to: opts.to };
}

/**
 * Delete an asset. The link graph is checked first so the refusal can name the count; the
 * schema's guard trigger (which also covers bundles and download codes) is the backstop.
 * The alias rows go with it — `cms_asset_alias.asset_id … ON DELETE CASCADE`.
 */
export function deleteAsset(db: Database.Database, key: string): { deleted: true; key: string } {
  const row = assetByKey(db, key);
  if (row === undefined) {
    // An alias is not an asset: deleting through one would be deleting by a URL that only 301s.
    const alias = db.prepare('SELECT asset_id FROM cms_asset_alias WHERE key = ?').get(key) as
      | { asset_id: number }
      | undefined;
    if (alias !== undefined) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'that key is an alias; delete the asset it points at', {
        key,
        asset_id: alias.asset_id,
      });
    }
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no asset with that key', { key });
  }
  const links = linksForAsset(db, row.id);
  if (links.length > 0) {
    throw new AppError('SKW_E_DM_ASSET_IN_USE', 'this asset is still referenced', {
      key,
      references: links.length,
      owners: links.slice(0, 10),
    });
  }
  try {
    db.prepare('DELETE FROM cms_asset WHERE id = ?').run(row.id);
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('SKW_E_DM_ASSET_IN_USE')) {
      throw new AppError('SKW_E_DM_ASSET_IN_USE', 'a bundle or a download code still references this asset', {
        key,
        reason: 'bundle_or_code',
      });
    }
    throw err;
  }
  return { deleted: true, key };
}

/**
 * The tenant's `storage_quota_bytes`, read from `control.db` — the one place a tenant's limits
 * are recorded (§12, `schema/control.sql`). The site database cannot answer this: it does not
 * know it belongs to a tenant with a quota.
 *
 * This is the *source* of the number `putBytes` enforces; the enforcement itself is in
 * `store.ts` and happens before the write. Kept here so an upload route in S3b has one call to
 * make and cannot accidentally pass a hard-coded limit.
 */
export function storageQuotaFor(controlDb: Database.Database, tenantKey: string): number {
  const row = controlDb.prepare('SELECT storage_quota_bytes FROM tenant WHERE key = ?').get(tenantKey) as
    | { storage_quota_bytes: number }
    | undefined;
  if (row === undefined) {
    throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no such tenant', { tenant: tenantKey });
  }
  return Number(row.storage_quota_bytes);
}

/** The tenant's quota, for a caller that already has the limit. */
export function tenantQuota(db: Database.Database, limitBytes: number): QuotaState {
  return quotaState(db, limitBytes);
}

export { usedBytes };
