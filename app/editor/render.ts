/**
 * Derive the render-time document from the stored one (D17, §10.2).
 *
 * The stored body names keys (`data-asset-key="banner/home"`); this is the only place a
 * URL is produced, and it produces it from the **row**, not from the body: `assetUrl()`
 * reads `key`, `mime` and `sha256`, so a rename is a one-row change and the `?v=` suffix
 * changes when the bytes do. A gated asset has no URL (`siteAsset().url === null`); its
 * key becomes the redeem path `/d/<key>`, which is the only address that can serve paid
 * bytes.
 *
 * A body that names an unknown key is a hard failure — `SKW_E_RT_ASSET_MISSING` at 503,
 * the same code the SSR path already raises — because the publish gate should have
 * refused it and a 404 dressed as a resource is the outcome D17 is written against.
 */
import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import { siteAsset } from '../assets/url.ts';
import type { FormIntentContext } from '../forms/intake.ts';
import { attr, type ElementNode, elements, parseHtml, serialize, setAttr } from './html.ts';

export interface RenderOptions {
  /** Overrides the per-asset `alt` when the body already carries one. */
  keepAlt?: boolean;
  /**
   * The intent context a core `<form>` needs (`_pt`, `_hp`, `action`). Absent on the export path,
   * which has no `SKW_SESSION_KEY` and cannot mint a token that would still be valid when a
   * visitor loads the bundle; the rendered form then carries `data-form-intent="absent"`.
   */
  forms?: FormIntentContext | undefined;
  /**
   * §13.3.4's `asset.url` filter, applied to the URL this render would emit for one key.
   *
   * It is a **function**, not a map, because the filter is a decision about one asset and
   * the caller already has the key: a map keyed by URL would need the URL computed twice
   * and would silently miss a second key that resolves to the same bytes. The dispatch that
   * builds this closure is asynchronous; the render is not, so `serveNotFound` runs the
   * filter once per key **before** the render and hands the answer in (§13.3.4, asset.url).
   * Returning `null` means "no change" — the same rule the bus applies to `undefined`.
   */
  urlFor?: ((key: string, url: string) => string | null) | undefined;
}

/** `/d/<key>` — the redeem page, for an asset that has no public URL. */
export function redeemPath(key: string): string {
  return `/d/${key}`;
}

function applyAsset(db: Database.Database, el: ElementNode, key: string, options: RenderOptions): void {
  let asset;
  try {
    asset = siteAsset(db, key);
  } catch {
    throw new AppError('SKW_E_RT_ASSET_MISSING', 'a page names an asset that does not exist', { key });
  }
  if (el.tag === 'img') {
    if (asset.url === null) {
      // A gated image in a body: there is no public URL to write, and writing the redeem
      // path into an <img> would serve HTML where bytes belong.
      throw new AppError('SKW_E_RT_ASSET_MISSING', 'a gated asset cannot be an <img src>', { key, reason: 'gated' });
    }
    const url = options.urlFor?.(key, asset.url) ?? asset.url;
    setAttr(el, 'src', url);
    if (asset.srcset !== '') setAttr(el, 'srcset', asset.srcset);
    if (asset.width !== null) setAttr(el, 'width', String(asset.width));
    if (asset.height !== null) setAttr(el, 'height', String(asset.height));
    if (!options.keepAlt && (attr(el, 'alt') ?? '') === '' && asset.alt !== '') setAttr(el, 'alt', asset.alt);
    return;
  }
  // A link: public bytes get the farm URL, gated bytes get the redeem path.
  setAttr(el, 'href', asset.url === null ? redeemPath(key) : (options.urlFor?.(key, asset.url) ?? asset.url));
}

/** Render a stored body: every `data-asset-key` becomes the URL the row implies. */
export function renderBody(db: Database.Database, bodyHtml: string, options: RenderOptions = {}): string {
  const tree = parseHtml(bodyHtml);
  for (const el of elements(tree)) {
    const key = attr(el, 'data-asset-key');
    if (key !== undefined) applyAsset(db, el, key, options);
  }
  return serialize(tree);
}

/**
 * The URLs a body would render, without rendering it — the export pre-flight's view
 * (§11.3 refusal 1: a gated asset present in an Astro/static bundle is refused by key).
 */
export function assetUrlsIn(db: Database.Database, bodyHtml: string): { key: string; url: string | null }[] {
  const out: { key: string; url: string | null }[] = [];
  for (const el of elements(parseHtml(bodyHtml))) {
    const key = attr(el, 'data-asset-key');
    if (key === undefined || out.some((o) => o.key === key)) continue;
    try {
      out.push({ key, url: siteAsset(db, key).url });
    } catch {
      out.push({ key, url: null });
    }
  }
  return out;
}
