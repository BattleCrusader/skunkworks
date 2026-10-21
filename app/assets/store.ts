/**
 * §7.1 / D13 — the byte tree. `content/media/<sha[0:2]>/<sha>.<ext>`, and nothing else.
 *
 * **The path is a function of the checksum.** No parameter of this module is a filename, so
 * there is no input that can produce `../`, an absolute path, or a name a module loader
 * would ever look at: `sha256` is checked against `^[0-9a-f]{64}$` and `ext` against the
 * eight tokens the DDL's generated column emits. That is the structural half of "the
 * filename never becomes a path segment" — the other half is `library.ts` refusing a
 * filename that contains a separator at all.
 *
 * **Immutability is a property of the syscall, not a policy.** The bytes are written to a
 * temporary name in the same directory and published with `linkSync`, which fails with
 * `EEXIST` if the target exists. So a second writer cannot overwrite a blob even by racing
 * the first: one of the two links wins and the other is told the blob is already there. A
 * plain `writeFileSync` to the final path — what a naive implementation does — makes the
 * "immutable" claim true only while nobody is looking.
 *
 * **The quota is checked before the write.** A check after `writeFile` is a report, not a
 * limit: the bytes are already on the tenant's disk when it fires. The order here is
 * `exists → quota → mkdir → write`, and the quota needs no bytes when the blob already
 * exists, so a deduplicated upload is free at exactly the quota.
 */
import type Database from 'better-sqlite3';
import { linkSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { AppError } from '../errors.ts';

/** The deploy layout (§12.2: `./content:/srv/content`). Sibling of `SKW_DATA_DIR`, not a child. */
export const DEFAULT_CONTENT_ROOT = '/srv/content';

/** `content/media/` — the prefix the DDL's generated `storage_path` column starts with. */
export const MEDIA_REL_PREFIX = 'content/media/';

/**
 * S8c's upload ceiling: 25 MiB, one file per request. A tenant's photo library is not a video
 * host, and the number is enforced three times — the multipart parser's `fileSize`, the
 * sniffer's `maxBytes`, and the tenant quota — because each is the only one that holds when
 * the other two are bypassed.
 */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Exactly the tokens in `cms_asset.storage_path`'s `CASE mime WHEN …`. */
export const EXTS = new Set(['webp', 'jpg', 'png', 'avif', 'pdf', 'mp4', 'mp3', 'zip', 'bin']);

const SHA = /^[0-9a-f]{64}$/;

export interface QuotaState {
  limitBytes: number;
  usedBytes: number;
}

export interface PutInput {
  /** The content root — `content/` itself, so the file lands in `<root>/media/...`. */
  contentRoot: string;
  sha256: string;
  bytes: Buffer;
  ext: string;
  /** Absent means "no quota on this path" (the exporter, a repair job). */
  quota?: QuotaState;
}

export interface PutResult {
  /** `content/media/hh/<sha>.<ext>` — equal to `cms_asset.storage_path` for the same row. */
  relPath: string;
  absPath: string;
  /** False when the blob already existed: dedupe, not a skip. */
  wrote: boolean;
}

/**
 * The one place a stored path is formed. `cms_asset.storage_path` is a generated column with
 * the same expression, so this is the app's copy of a rule the schema already enforces; the
 * gate asserts the two agree on a real row rather than trusting the parallel text.
 */
export function mediaRelPath(sha256: string, ext: string): string {
  if (!SHA.test(sha256)) throw new AppError('SKW_E_PLT_INTERNAL', 'not a sha256');
  if (!EXTS.has(ext)) throw new AppError('SKW_E_PLT_INTERNAL', 'not a stored extension');
  return `${MEDIA_REL_PREFIX}${sha256.slice(0, 2)}/${sha256}.${ext}`;
}

/** `content/media/hh/<sha>.<ext>` → `<root>/media/hh/<sha>.<ext>`. */
export function pathUnder(contentRoot: string, relPath: string): string {
  if (!relPath.startsWith(MEDIA_REL_PREFIX)) throw new AppError('SKW_E_PLT_INTERNAL', 'not a media path');
  return join(contentRoot, relPath.slice('content/'.length));
}

/**
 * Physical bytes the tenant holds: the sum over **distinct checksums**.
 *
 * `SUM(bytes)` over rows would charge a tenant twice for two keys that share one blob, and
 * one download would then be paid for by a page that only references the other key. The
 * dedupe is the point of D13, so the quota counts what the disk actually stores.
 */
export function usedBytes(db: Database.Database): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(b), 0) AS n FROM (SELECT DISTINCT sha256, bytes AS b FROM cms_asset)')
    .get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function quotaState(db: Database.Database, limitBytes: number): QuotaState {
  return { limitBytes, usedBytes: usedBytes(db) };
}

/**
 * Write one blob, or report that it is already there.
 *
 * The failure modes are each a decision:
 *   - over quota → `507 SKW_E_DM_QUOTA`, **before** any filesystem call that creates a path;
 *   - an existing blob of a different size → an integrity failure (`SKW_E_PLT_INTERNAL`): the
 *     address and the content disagree, and serving either would be a lie about the other;
 *   - a lost race (`EEXIST` from `linkSync`) → dedupe, exactly like a second upload.
 */
export function putBytes(input: PutInput): PutResult {
  const relPath = mediaRelPath(input.sha256, input.ext);
  const absPath = pathUnder(input.contentRoot, relPath);

  const existing = sizeOf(absPath);
  if (existing !== null) {
    if (existing !== input.bytes.length) {
      throw new AppError('SKW_E_PLT_INTERNAL', 'the stored blob does not match its checksum length', {
        sha256: input.sha256,
        stored: existing,
        uploaded: input.bytes.length,
      });
    }
    return { relPath, absPath, wrote: false };
  }

  if (input.quota !== undefined && input.quota.usedBytes + input.bytes.length > input.quota.limitBytes) {
    throw new AppError('SKW_E_DM_QUOTA', 'the tenant has no storage quota left for this upload', {
      limit_bytes: input.quota.limitBytes,
      used_bytes: input.quota.usedBytes,
      needed_bytes: input.bytes.length,
    });
  }

  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = join(dirname(absPath), `.tmp-${randomUUID()}`);
  writeFileSync(tmp, input.bytes, { flag: 'wx' });
  try {
    // Publish atomically and exclusively: `linkSync` cannot replace an existing target.
    linkSync(tmp, absPath);
    return { relPath, absPath, wrote: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { relPath, absPath, wrote: false };
    throw err;
  } finally {
    unlinkSync(tmp);
  }
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
