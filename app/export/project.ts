/**
 * **The projection** — one read of the content, one set of refusals, three serialisers
 * (§11.1–§11.3, §6.4, D22/D24/D35).
 *
 * `buildProjection()` is the only code in the tree that decides what an export
 * *contains*. The three writers (`cms.ts`, `astro.ts`, `static.ts`) receive the same
 * `Projection` object and differ only in how they lay bytes on disk; none of them
 * re-derives an asset URL, re-renders a body or re-parses `body_html`. That is the rule
 * D22 states as "export target is a render mode, not a fork", and the reason
 * `projectionSha` is identical across the three trees for one database and one clock.
 *
 * The page body is produced by `renderStoredBody()` — **the function the site's serve
 * path calls** — so an export cannot drift from the site without both going red
 * (`test/export-shared-path.test.ts` is the mutation proof, not an assertion).
 *
 * ## The refusals, and what each one means
 *
 * §11.3 names six. This module raises four of them; quiescence (§11.4) and disk
 * (§11.3 #6) live in `cms.ts` and the CLI because they are properties of the write, not
 * of the projection.
 *
 *   1. `SKW_E_EXP_GATED_ASSETS` — a gated key is referenced by a page that the Astro or
 *      static target will render. Those targets have no download plane: the bytes have
 *      no address at all, so the link would 404 forever. The refusal names **every key
 *      and every page**, because a client fixing one at a time pays for one export per
 *      key. The CMS bundle is exempt by §11.1's own table ("Gated downloads: yes").
 *   2. `SKW_E_EXP_MEDIA_GRAPH_OPEN` — a gated asset is linked from an owner the target
 *      *does* carry (a settings row, a datasource, a bundle), while the asset itself is
 *      not carried. Keeping the `cms_asset_link` row leaves a dangling reference in the
 *      client's CMS; dropping it makes their "delete this image" warning lie. There is
 *      no good answer to that pair, so the export refuses and names both ends.
 *   3. `SKW_E_EXP_PARAMETERISED` — a `free` parameter (a search box, §6.4) appears in a
 *      link on an exported page. A static SKU cannot answer it: the snapshot enumerates
 *      the declared domains, and a free one has no domain to enumerate. Names the source
 *      **and** the link, so the operator can see which page promised it.
 *   4. `SKW_E_EXP_BODY_UNNORMALISABLE` / `SKW_E_EXP_ASSET_UNRESOLVED` — a legacy row that
 *      is still a document after `unwrapBody()`, or a body naming a key with no row (or
 *      no file on disk). Both are refused by name rather than skipped: a page silently
 *      missing from a bundle is the failure mode every one of these codes exists for.
 *
 * ## Determinism
 *
 * Everything here is a pure function of the database rows and `exportNow`: pages are
 * ordered by code-unit comparison of `path`, assets by `key`, refusal details by their
 * own keys. No `Date.now()`, no `fs` ordering, no `toLocaleString`. Two calls at one
 * `SKW_EXPORT_NOW` produce the same `Projection` and therefore the same bytes.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { assetRefsInHtml } from '../assets/links.ts';
import { EXT_BY_MIME, linkName, linkTargetOf } from '../assets/farm.ts';
import { assetUrl } from '../assets/url.ts';
import { elements, attr, parseHtml } from '../editor/html.ts';
import { AppError } from '../errors.ts';
import { renderStoredBody } from '../render/body.ts';

export type ExportTarget = 'cms' | 'astro' | 'static';
export const EXPORT_TARGETS: readonly ExportTarget[] = ['cms', 'astro', 'static'];

/** §11.3's exit codes, keyed by the code that is raised. */
export const REFUSAL_EXIT: Record<string, number> = {
  SKW_E_EXP_GATED_ASSETS: 21,
  SKW_E_EXP_MEDIA_GRAPH_OPEN: 21,
  SKW_E_EXP_BODY_UNNORMALISABLE: 21,
  SKW_E_EXP_ASSET_UNRESOLVED: 21,
  SKW_E_EXP_PARAMETERISED: 22,
  SKW_E_PL_EXPORT_FORWARD_NO_TARGET: 23,
  SKW_E_EXP_NOT_QUIESCENT: 24,
  SKW_E_EXP_INSUFFICIENT_DISK: 25,
};

export interface Refusal {
  code: string;
  message: string;
  detail: Record<string, unknown>;
  /** §11.3's exit code for this code. */
  exit: number;
}

export interface ProjectedPage {
  id: number;
  path: string;
  slug: string;
  title: string;
  /** The fragment the shell interpolates into `<main>` — already asset-resolved. */
  bodyHtml: string;
  bodyCss: string;
  /** sha256 of `bodyHtml`, so a bundle can state what it shipped. */
  bodySha: string;
}

export type AccessClass = 'public' | 'linked-private' | 'gated';

export interface ProjectedAsset {
  key: string;
  kind: string;
  mime: string;
  sha256: string;
  bytes: number;
  /** `content/media/<hh>/<sha>.<ext>`, from the generated column (C-17). */
  storagePath: string;
  /** `/media/<key>.<ext>?v=<sha8>` — the D17 URL, derived here and nowhere else. */
  url: string;
  accessClass: AccessClass;
  width: number | null;
  height: number | null;
  alt: string;
}

export interface Projection {
  version: 2;
  tenantKey: string;
  exportNow: string;
  pages: ProjectedPage[];
  /** Public bytes referenced by an exported page — the same list in all three targets. */
  referenced: ProjectedAsset[];
  /** Every non-gated row in the library. The CMS bundle ships this; the others ignore it. */
  library: ProjectedAsset[];
  /** Every gated row. The CMS bundle ships it (the redeem plane); the others refuse it. */
  gated: ProjectedAsset[];
  contentSha: string;
  mediaSha: string;
  /** `contentSha:mediaSha` — the same value in all three trees. */
  projectionSha: string;
}

export interface BuildOptions {
  db: Database.Database;
  tenantKey: string;
  target: ExportTarget;
  /** `SKW_EXPORT_NOW`, ISO 8601. The only clock an export may read (§6.4). */
  exportNow: string;
  /** Absolute path to the live `content/` root, for the file-exists check. */
  contentRoot: string;
}

export type BuildResult = { ok: true; projection: Projection } | { ok: false; refusals: Refusal[] };

interface PageRow {
  id: number;
  path: string;
  slug: string;
  title: string;
  body_html: string;
  body_css: string;
}

interface AssetRow {
  id: number;
  key: string;
  kind: string;
  mime: string;
  sha256: string;
  bytes: number;
  access_class: string;
  storage_path: string;
  width: number | null;
  height: number | null;
  alt_text: string | null;
}

interface LinkRow {
  asset_id: number;
  owner_kind: string;
  owner_id: number;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Code-unit order, so the sequence does not depend on a collation or a locale. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function toAsset(row: AssetRow): ProjectedAsset {
  const ext = EXT_BY_MIME[row.mime];
  // The exporter may not invent an extension for a mime outside the closed set: the
  // generated column would not have produced one either, and the farm would refuse it.
  if (ext === undefined) {
    throw new AppError('SKW_E_PLT_INTERNAL', 'an asset mime outside the closed set reached the exporter', {
      key: row.key,
      mime: row.mime,
    });
  }
  return {
    key: row.key,
    kind: row.kind,
    mime: row.mime,
    sha256: row.sha256,
    bytes: row.bytes,
    storagePath: row.storage_path,
    url: assetUrl({ key: row.key, mime: row.mime, sha256: row.sha256 }),
    accessClass: row.access_class as AccessClass,
    width: row.width,
    height: row.height,
    alt: row.alt_text ?? '',
  };
}

/** `content/media/…` → `<contentRoot>/media/…`, and whether the bytes are there. */
export function assetFile(contentRoot: string, asset: ProjectedAsset): string {
  return join(contentRoot, asset.storagePath.replace(/^content\//, ''));
}

/**
 * `content/public/<key>.<ext>` and its relative target.
 *
 * Both halves come from `app/assets/farm.ts` — `linkName()` for the name and
 * `linkTargetOf()` for the `../` depth, which is a function of how many `/` segments the
 * key has. A key may nest (`team/studio`), and a hand-rolled `../media/…` target would
 * resolve one directory too shallow; `bundle_verify` catches it as "missing file", which
 * is how this was found.
 */
export function symlinkTarget(asset: ProjectedAsset): { name: string; target: string } {
  const name = linkName(asset.key, EXT_BY_MIME[asset.mime] ?? 'bin');
  return { name, target: linkTargetOf(asset.storagePath, name.split('/').length) };
}

function refusal(code: string, message: string, detail: Record<string, unknown>): Refusal {
  return { code, message, detail, exit: REFUSAL_EXIT[code] ?? 1 };
}

/**
 * Project one database for one target.
 *
 * The order of the checks is the order of the report: a gated page and a free parameter
 * are both refusals, and the operator should see the gated one first because it is the
 * one that changes the SKU.
 */
export function buildProjection(opts: BuildOptions): BuildResult {
  const { db } = opts;
  const refusals: Refusal[] = [];

  const pageRows = db
    .prepare(
      `SELECT id, path, slug, title, body_html, body_css
         FROM cms_page WHERE status = 'published'`,
    )
    .all() as PageRow[];
  pageRows.sort((a, b) => byString(a.path, b.path));

  // --- 1. every body through the site's own projection -------------------------
  const pages: ProjectedPage[] = [];
  for (const row of pageRows) {
    try {
      const bodyHtml = renderStoredBody(db, row.body_html);
      pages.push({
        id: row.id,
        path: row.path,
        slug: row.slug,
        title: row.title,
        bodyHtml,
        bodyCss: row.body_css,
        bodySha: sha256(bodyHtml),
      });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      if (err.code === 'SKW_E_RT_ASSET_MISSING') {
        refusals.push(
          refusal('SKW_E_EXP_ASSET_UNRESOLVED', 'a page names an asset this export cannot resolve', {
            page: row.path,
            key: String((err.detail as { key?: unknown }).key ?? ''),
            reason: String((err.detail as { reason?: unknown }).reason ?? 'missing'),
          }),
        );
        continue;
      }
      refusals.push(
        refusal('SKW_E_EXP_BODY_UNNORMALISABLE', 'a stored body is not a fragment and cannot be normalised', {
          page: row.path,
          rule: String((err.detail as { rule?: unknown }).rule ?? 'unknown'),
          bytes: Number((err.detail as { bytes?: unknown }).bytes ?? 0),
        }),
      );
    }
  }

  const allAssets = (db.prepare(
    `SELECT id, key, kind, mime, sha256, bytes, access_class, storage_path, width, height, alt_text
       FROM cms_asset`,
  ).all() as AssetRow[]).map(toAsset);
  allAssets.sort((a, b) => byString(a.key, b.key));
  const byKey = new Map(allAssets.map((a) => [a.key, a]));
  const library = allAssets.filter((a) => a.accessClass !== 'gated');
  const gated = allAssets.filter((a) => a.accessClass === 'gated');
  const gatedKeys = new Set(gated.map((a) => a.key));

  // --- 2. the gated-asset refusal, per exported page ---------------------------
  // The stored bytes are scanned, not the rendered ones: the rendered bytes carry URLs
  // and a gated asset has none, so scanning after the render would miss exactly the
  // asset this code is for. `assetRefsInHtml` is the same reader that writes
  // `cms_asset_link`, so the refusal and the usage graph cannot disagree.
  if (opts.target !== 'cms') {
    const hits: { key: string; page: string }[] = [];
    for (const row of pageRows) {
      for (const key of assetRefsInHtml(row.body_html)) {
        if (gatedKeys.has(key)) hits.push({ key, page: row.path });
      }
    }
    if (hits.length > 0) {
      const keys = [...new Set(hits.map((h) => h.key))].sort(byString);
      refusals.push(
        refusal('SKW_E_EXP_GATED_ASSETS', 'a gated asset cannot be exported to a target with no download plane', {
          target: opts.target,
          keys,
          pages: hits.map((h) => h.page),
          assets: hits.sort((a, b) => byString(a.key, b.key) || byString(a.page, b.page)),
        }),
      );
    }
  }

  // --- 3. an open media graph --------------------------------------------------
  // A link row from a gated asset to an owner this target carries, when the target does
  // not carry the gated asset. Page owners are excluded: §11.3 #1 already names them,
  // with the page, and two codes for one condition is a support ticket.
  if (opts.target !== 'cms') {
    const links = db
      .prepare(`SELECT asset_id, owner_kind, owner_id FROM cms_asset_link ORDER BY owner_kind, owner_id`)
      .all() as LinkRow[];
    const gatedIds = new Set(gated.map((a) => a.key));
    const idToKey = new Map<number, string>();
    for (const row of db.prepare(`SELECT id, key FROM cms_asset`).all() as { id: number; key: string }[]) {
      idToKey.set(row.id, row.key);
    }
    const open: { key: string; owner_kind: string; owner_id: number }[] = [];
    for (const link of links) {
      const key = idToKey.get(link.asset_id);
      if (key === undefined || !gatedIds.has(key)) continue;
      if (link.owner_kind === 'page') continue;
      // settings / datasource / bundle rows travel in every target (the CMS bundle and
      // the snapshots), so an owner of one of those kinds is carried by construction.
      open.push({ key, owner_kind: link.owner_kind, owner_id: link.owner_id });
    }
    if (open.length > 0) {
      refusals.push(
        refusal('SKW_E_EXP_MEDIA_GRAPH_OPEN', 'a gated asset is linked from an owner this export carries', {
          target: opts.target,
          keys: [...new Set(open.map((o) => o.key))].sort(byString),
          links: open.sort((a, b) => byString(a.key, b.key) || byString(a.owner_kind, b.owner_kind) || a.owner_id - b.owner_id),
        }),
      );
    }
  }

  // --- 4. a free parameter in a link -------------------------------------------
  const freeParams = new Map<string, string[]>();
  for (const row of db.prepare(`SELECT key, params_json FROM cms_datasource ORDER BY key`).all() as {
    key: string;
    params_json: string;
  }[]) {
    let params: unknown;
    try {
      params = JSON.parse(row.params_json);
    } catch {
      continue;
    }
    if (!Array.isArray(params)) continue;
    for (const param of params as { name?: unknown; kind?: unknown }[]) {
      if (param.kind !== 'free' || typeof param.name !== 'string') continue;
      const list = freeParams.get(param.name) ?? [];
      list.push(row.key);
      freeParams.set(param.name, list);
    }
  }
  if (freeParams.size > 0) {
    for (const page of pages) {
      for (const el of elements(parseHtml(page.bodyHtml))) {
        if (el.tag !== 'a') continue;
        const href = attr(el, 'href');
        if (href === undefined || !href.includes('?')) continue;
        const query = href.slice(href.indexOf('?') + 1).split('#')[0] ?? '';
        for (const pair of query.split('&')) {
          const name = decodeURIComponent(pair.split('=')[0] ?? '');
          const sources = freeParams.get(name);
          if (sources === undefined) continue;
          refusals.push(
            refusal('SKW_E_EXP_PARAMETERISED', 'a link carries a free parameter, which a snapshot cannot enumerate', {
              page: page.path,
              link: href,
              param: name,
              sources: [...sources].sort(byString),
            }),
          );
        }
      }
    }
  }

  // --- 5. every referenced byte must exist --------------------------------------
  const referencedKeys = new Set<string>();
  for (const row of pageRows) for (const key of assetRefsInHtml(row.body_html)) referencedKeys.add(key);
  const referenced = [...referencedKeys]
    .map((key) => byKey.get(key))
    .filter((a): a is ProjectedAsset => a !== undefined)
    .sort((a, b) => byString(a.key, b.key));

  // The CMS bundle ships the whole library, so its file check covers that; the other two
  // ship only what a page names.
  const carried = opts.target === 'cms' ? [...library, ...gated] : referenced;
  for (const asset of carried) {
    if (existsSync(assetFile(opts.contentRoot, asset))) continue;
    refusals.push(
      refusal('SKW_E_EXP_ASSET_UNRESOLVED', 'an asset row has no bytes on disk', {
        key: asset.key,
        path: asset.storagePath,
      }),
    );
  }

  // A page that referenced a key with no row is already refused above (renderStoredBody
  // raised ASSET_MISSING). A referenced key whose row exists but is gated was refused by
  // #2. Nothing else can be missing from `referenced`.

  if (refusals.length > 0) {
    // Stable order: by code, then by the JSON of the detail, so a test can assert the
    // exact list without depending on the order the checks ran in.
    refusals.sort((a, b) => byString(a.code, b.code) || byString(JSON.stringify(a.detail), JSON.stringify(b.detail)));
    return { ok: false, refusals };
  }

  const contentSha = sha256(
    JSON.stringify(pages.map((p) => ({ path: p.path, title: p.title, body: p.bodyHtml, css: p.bodyCss }))),
  );
  const mediaSha = sha256(JSON.stringify(referenced.map((a) => ({ key: a.key, sha256: a.sha256, url: a.url }))));

  return {
    ok: true,
    projection: {
      version: 2,
      tenantKey: opts.tenantKey,
      exportNow: opts.exportNow,
      pages,
      referenced,
      library,
      gated,
      contentSha,
      mediaSha,
      projectionSha: `${contentSha}:${mediaSha}`,
    },
  };
}
