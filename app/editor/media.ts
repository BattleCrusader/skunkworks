/**
 * The media picker (D17): a pick writes the **key**, never the URL.
 *
 * The picker's whole contract is one sentence — "the editor never writes a URL for an
 * image" — and it is enforced in two places, because a browser-side rule is not a rule:
 *
 *  - here, `applyPick()` sets `data-asset-key` and *removes* `src`/`srcset`/`href` from the
 *    node it patched, so the document it hands back has no URL in it;
 *  - and in `model.ts`'s `assertAssetKeys()`, which refuses a body that carries a URL
 *    where a key belongs. A client that skips this module (curl) cannot get a URL past it.
 *
 * `pickAsset()` reads the row so the picker can show a thumbnail and the alt text; the
 * thumbnail URL exists for the **admin canvas only** and is never part of the document.
 */
import type Database from 'better-sqlite3';

import { assetByKey } from '../assets/library.ts';
import { AppError } from '../errors.ts';
import { attr, type ElementNode, elements, parseHtml, serialize, setAttr } from './html.ts';
import type { FieldType } from './registry.ts';

export interface Pick {
  key: string;
  /** `/media/<key>.<ext>?v=<sha8>`, or null for a gated asset. Canvas only. */
  previewUrl: string | null;
  alt: string;
  filename: string;
  mime: string;
  accessClass: string;
}

export function pickAsset(db: Database.Database, key: string): Pick {
  const row = assetByKey(db, key);
  if (row === undefined) {
    throw new AppError('SKW_E_DM_KEY_IN_USE', `no asset with key ${JSON.stringify(key)}`, { key });
  }
  // A gated asset's farm link does not exist; the canvas shows a placeholder instead of a
  // URL (the same rule `siteAsset()` states for templates).
  const previewUrl = row.access_class === 'gated' ? null : `/media/${row.key}.${ext(row.mime)}?v=${row.sha256.slice(0, 8)}`;
  return {
    key: row.key,
    previewUrl,
    alt: row.alt_text ?? '',
    filename: row.filename,
    mime: row.mime,
    accessClass: row.access_class,
  };
}

function ext(mime: string): string {
  switch (mime) {
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/avif':
      return 'avif';
    case 'application/pdf':
      return 'pdf';
    case 'video/mp4':
      return 'mp4';
    case 'audio/mpeg':
      return 'mp3';
    case 'application/zip':
      return 'zip';
    default:
      return 'bin';
  }
}

/**
 * Set the key on the element the field names, in the component the caller selected.
 * `prop` is matched against a `data-prop` inside the component whose `data-gjs-type` is
 * `type`; when `prop` is absent the component's root element is patched.
 *
 * Returns the whole (unchanged apart from that node) document, because the editor replaces
 * the canonical document rather than patching its own model — one source of truth.
 */
export function applyPick(
  html: string,
  target: { type: string; prop?: string; field: FieldType },
  key: string,
): string {
  const tree = parseHtml(html);
  const component = elements(tree).find((el) => attr(el, 'data-gjs-type') === target.type);
  if (component === undefined) {
    throw new AppError('SKW_E_RT_COMPONENT_UNKNOWN', `no ${target.type} component in this document`, {
      type: target.type,
    });
  }
  const field = target.prop === undefined
    ? component
    : elements([component]).find((el) => attr(el, 'data-prop') === target.prop);
  if (field === undefined) {
    throw new AppError('SKW_E_RT_BODY_FORBIDDEN', `no data-prop="${target.prop ?? ''}" in ${target.type}`, {
      type: target.type,
      prop: target.prop ?? null,
    });
  }
  setAttr(field, 'data-asset-key', key);
  // The value is a key, so every URL-shaped attribute on this node is a canvas artefact.
  field.attrs = field.attrs.filter(([k]) => k !== 'src' && k !== 'srcset' && k !== 'href');
  if (field.tag === 'img') setAttr(field, 'alt', '');
  return serialize(tree);
}

/** The picker's list: keys, thumbnails and alt text — never a document URL. */
export function mediaChoices(db: Database.Database, query = '', limit = 60): Pick[] {
  const like = `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const rows = db
    .prepare(
      `SELECT key, filename, mime, alt_text, access_class, sha256
         FROM cms_asset
        WHERE key LIKE ? ESCAPE '\\' OR filename LIKE ? ESCAPE '\\'
        ORDER BY key LIMIT ?`,
    )
    .all(like, like, limit) as { key: string; filename: string; mime: string; alt_text: string | null; access_class: string; sha256: string }[];
  return rows.map((row) => ({
    key: row.key,
    previewUrl: row.access_class === 'gated' ? null : `/media/${row.key}.${ext(row.mime)}?v=${row.sha256.slice(0, 8)}`,
    alt: row.alt_text ?? '',
    filename: row.filename,
    mime: row.mime,
    accessClass: row.access_class,
  }));
}

export type { ElementNode };
