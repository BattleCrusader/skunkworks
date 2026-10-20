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
import { readFileSync } from 'node:fs';

import type { TreeFile } from './tree.ts';
import { renderDocument } from './document.ts';
import { renderNotes } from './notes.ts';
import { assetFile, type Projection } from './project.ts';

export interface StaticOptions {
  projection: Projection;
  /** The live `content/` root, for the byte copies. */
  contentRoot: string;
  origin?: string;
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

  for (const page of projection.pages) {
    files.push({
      path: pageFile(page.path),
      bytes: renderDocument({
        tenantKey: projection.tenantKey,
        path: page.path,
        title: page.title,
        bodyHtml: page.bodyHtml,
        bodyCss: page.bodyCss,
      }),
    });
  }

  for (const asset of projection.referenced) {
    files.push({ path: mediaFile(asset.url), bytes: readFileSync(assetFile(options.contentRoot, asset)) });
  }

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
