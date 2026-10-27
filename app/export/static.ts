/**
 * Target 3 — **static HTML + JS** (§11.1). Copy the files; there is no runtime.
 *
 * The tree is `index.html`, one directory per path, `media/**`, `robots.txt`,
 * `sitemap.xml` and `EXPORT-NOTES.md`. Two decisions are load-bearing:
 *
 * 1. **The bytes live at the URL the render derived.** `renderBody()` turns a key into
 *    `/media/<key>.<ext>?v=<sha8>`, so the file is written at `media/<key>.<ext>` — the
 *    query string is a cache-buster the static server ignores. Putting the bytes under
 *    `assets/` (the SDS §11.1 heading) would make every image on every page a 404, so
 *    the directory is `media/`; `EXPORT-NOTES.md` says so, and the export gate serves
 *    the tree and fetches the images.
 * 2. **`sitemap.xml` is emitted only when an origin is known.** A sitemap's `<loc>` must
 *    be absolute; a relative one is invalid XML for a crawler and a 404 for a browser.
 *    Without an origin the export ships no sitemap rather than a broken one, and the
 *    notes say why.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { TreeFile } from './tree.ts';
import { pageCssPath, renderDocument } from './document.ts';
import { pageSeoHead } from '../render/seo.ts';
import { renderNotes } from './notes.ts';
import { assetFile, type Projection } from './project.ts';
import { CSP_CONF_FILE, cspConf } from '../render/csp.ts';

export interface StaticOptions {
  projection: Projection;
  /** The live `content/` root, for the byte copies. */
  contentRoot: string;
  origin?: string;
  /**
   * The tenant's active theme, verbatim. Written once as `/theme.css` and linked by every document,
   * which is the same URL the live site serves and the same bytes — a static tree that only
   * carried `body_css` would deploy a site with no look at all.
   */
  sheet?: string;
  /**
   * The theme package's files, on disk, and the key they are served under. The sheet names them
   * absolutely (`/_theme/<key>/assets/x?v=<sha8>`); a file server ignores the query, so the same
   * bytes at the same path are all a static tree needs.
   */
  themeAssets?: { key: string; root: string };
}

/** `/about` → `about/index.html`; `/` → `index.html` (§11.1: one directory per path). */
export function pageFile(path: string): string {
  if (path === '/') return 'index.html';
  return `${path.replace(/^\//, '')}/index.html`;
}

/** `/media/<key>.<ext>?v=<sha8>` → `media/<key>.<ext>` — the file the URL resolves to. */
export function mediaFile(url: string): string {
  return url.replace(/^\//, '').replace(/\?.*$/, '');
}

function sitemap(projection: Projection, origin: string): string {
  const base = origin.replace(/\/$/, '');
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  out.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  for (const page of projection.pages) out.push(`  <url><loc>${base}${page.path === '/' ? '/' : page.path}</loc></url>`);
  out.push('</urlset>');
  out.push('');
  return out.join('\n');
}

export function planStatic(options: StaticOptions): TreeFile[] {
  const { projection } = options;
  const files: TreeFile[] = [];

  // S8s: every stylesheet a document names, written once. A page with CSS links `_css/<sha>.css`
  // and this tree is served by a plain file server, so the file has to exist at exactly that path
  // — the same absolute URL the live site answers, which is what keeps the two trees identical.
  const sheets = new Map<string, string>();
  for (const page of projection.pages) {
    if (page.bodyCss !== '') sheets.set(pageCssPath(page.bodyCss), page.bodyCss);
  }
  for (const [path, css] of sheets) files.push({ path: path.replace(/^\//, ''), bytes: css });

  const sheet = options.sheet === undefined || options.sheet === '' ? null : options.sheet;
  if (sheet !== null) files.push({ path: 'theme.css', bytes: sheet });
  const themeAssets = options.themeAssets;
  if (themeAssets !== undefined && existsSync(themeAssets.root)) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          const rel = relative(themeAssets.root, full).split(sep).join('/');
          files.push({ path: `_theme/${themeAssets.key}/${rel}`, bytes: readFileSync(full) });
        }
      }
    };
    walk(themeAssets.root);
  }

  for (const page of projection.pages) {
    files.push({
      path: pageFile(page.path),
      bytes: renderDocument({
        tenantKey: projection.tenantKey,
        path: page.path,
        title: page.title,
        bodyHtml: page.bodyHtml,
        bodyCss: page.bodyCss,
        ...(sheet === null ? {} : { sheetHref: '/theme.css' }),
        ...(page.seo === null
          ? {}
          : {
              head: pageSeoHead({
                seo: page.seo,
                path: page.path,
                documentTitle: page.title,
                // The static tree has no chrome record: `og:site_name` stays out rather than
                // being guessed from the page title.
                siteName: '',
                origin: options.origin === undefined ? null : options.origin.replace(/\/$/, ''),
              }),
            }),
      }),
    });
  }

  for (const asset of projection.referenced) {
    files.push({ path: mediaFile(asset.url), bytes: readFileSync(assetFile(options.contentRoot, asset)) });
  }

  // §10.5 (C-12, S4c): the CSP this tree must be served with. One line, the same bytes as
  // the live header and the CMS snippet; `test/csp.test.ts` compares the sha256 of all three.
  files.push({ path: CSP_CONF_FILE, bytes: cspConf() });

  files.push({ path: 'robots.txt', bytes: 'User-agent: *\nAllow: /\n' });
  if (options.origin !== undefined) files.push({ path: 'sitemap.xml', bytes: sitemap(projection, options.origin) });

  files.push({
    path: 'EXPORT-NOTES.md',
    bytes: renderNotes({
      target: 'static',
      projection,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      lines: [
        '- **Runtime on the client box:** none. Copy the tree to a web root and serve it.',
        '- **Pages** are `index.html` and one directory per path, so `/about` is `about/index.html`.',
        '- **Bytes** are under `media/`, at the URL the render derived (`?v=` is ignored by a static server).',
        options.origin === undefined
          ? '- **No `sitemap.xml`:** the export was given no origin, and a relative `<loc>` is not a sitemap.'
          : `- **\`sitemap.xml\`** lists every page against \`${options.origin}\`.`,
      ],
    }),
  });

  return files;
}
