/**
 * The files a crawler and a browser ask for before they ask for anything else (S8r).
 *
 * ## The measurements that produced this file
 *
 * A Lighthouse run against a live tenant (`https://abc123.com/`) scored **SEO 90**, and the
 * missing ten points were one audit: `meta-description`. Everything else about discovery was
 * also absent, in a way no Lighthouse category covers:
 *
 *   /robots.txt      404 (a JSON error body)
 *   /sitemap.xml     404
 *   /favicon.ico     404 — and it is requested by the browser on **every** page load
 *
 * The site itself was not slow: desktop scored 100 / LCP 0.4 s, and the server answers a warm
 * navigation in 6 ms. What it did not have was the paperwork, and a static Astro build gets
 * that paperwork by accident because `public/` is a directory of files. A CMS has to produce
 * it, so it is produced here from the same rows the pages come from.
 *
 * ## What each file is
 *
 *   `/robots.txt`   allows everything a tenant publishes and points at the sitemap. There is no
 *                   `/admin` Disallow: it is a 404 to a crawler anyway (row 7), it is the only
 *                   path that would be named, and naming it would publish the fact that this box
 *                   serves a CMS.
 *   `/sitemap.xml`  every published `cms_page`, plus every row a package exposes as a detail
 *                   page (`/blog/<slug>` and its kin), each with `<lastmod>` where the row can
 *                   supply one. Rows are read through the package's own declaration, so a new
 *                   package joins the sitemap by declaring a page — not by editing this file.
 *   `/favicon.svg`  the site's initial on the site's own paper colour, drawn once per tenant and
 *                   cached for a day. A site with no title gets the first letter of its key.
 *   `/favicon.ico`  the same mark as a PNG. Chrome sniffs the bytes rather than trusting the
 *                   extension, so a real PNG at that URL ends the 404 that every page load was
 *                   making.
 *   `/skw-nav.js`   see the note on `NAV_SCRIPT`.
 *
 * ## Escaping
 *
 * XML is not HTML and its five characters are not HTML's: `&` and `<` must be escaped, `>` is
 * conventional, and a quote inside `content="…"` must be escaped too. `xmlEscape` is the whole
 * of it, applied to every value that reaches the document.
 */

/** XML text and attribute escaping: the five characters, in the order that does not double-escape. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** One row of the sitemap: an absolute URL and an optional last-modified date. */
export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

/**
 * The sitemap. `<loc>` is absolute because the protocol says so: a crawler has no `Host` to
 * resolve a relative path against, which is why the caller passes the request's own origin.
 *
 * A `lastmod` is included only when the row has a timestamp, and it is formatted as the
 * protocol wants (`YYYY-MM-DD`). A wrong `lastmod` is worse than none: it teaches a crawler to
 * distrust the file.
 */
export function sitemapXml(entries: readonly SitemapEntry[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const entry of entries) {
    lines.push('  <url>');
    lines.push(`    <loc>${xmlEscape(entry.loc)}</loc>`);
    if (entry.lastmod !== undefined && entry.lastmod !== '') {
      const day = entry.lastmod.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) lines.push(`    <lastmod>${day}</lastmod>`);
    }
    lines.push('  </url>');
  }
  lines.push('</urlset>', '');
  return lines.join('\n');
}

/**
 * The robots file.
 *
 * `Sitemap:` is a bare absolute URL and not a directive a crawler may ignore: it is how a
 * crawler that found the site by accident learns the site has an index at all.
 */
export function robotsTxt(origin: string): string {
  // `/search` is disallowed as well as `noindex`: the results page is a derivative of the site's
  // own pages, and a crawler that walks `?q=` with a dictionary turns one page into a thousand.
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /search',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

/**
 * The mark: one letter on a rounded square.
 *
 * Letter and colour both come from the site's own settings, so two tenants of one box do not
 * share an icon — which is what a static default would have done, and it is visible in a tab
 * strip. The letter is the site title's first character when there is one, else the tenant key's;
 * non-Latin text is kept as it is, because a favicon is a glyph and not a font.
 */
export function faviconSvg(letter: string, background = '#17170f', ink = '#fbf8f2'): string {
  const glyph = letter.trim() === '' ? '·' : [...letter.trim()][0] ?? '·';
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img">',
    `<rect width="64" height="64" rx="12" fill="${background}"/>`,
    `<text x="32" y="45" font-family="ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif" font-size="38" font-weight="600" text-anchor="middle" fill="${ink}">${xmlEscape(glyph)}</text>`,
    '</svg>',
    '',
  ].join('\n');
}

/**
 * NOT SHIPPED — the prefetch script this file used to describe, and why.
 *
 * A `rel=prefetch` on hover is the obvious answer to "a click costs a document round trip", and it
 * was built and wired into the shell. Then it was measured in Chrome over CDP
 * (`scratch/cdp-prefetch.mjs`):
 *
 *   hover  → one request for `/pricing`, type `Other`           (the prefetch fired)
 *   click  → `Document`, `fromPrefetchCache: false`,
 *            `transferSize: 1991`, `ttfb: 11 ms`                (a fresh request all the same)
 *
 * The reason is the page's own header: site documents are `cache-control: no-store`, so the
 * prefetched response is discarded before the click can use it. `no-store` is deliberate — a CMS
 * that publishes must show the publish immediately — and a speculative fetch does not get to
 * outrank it. The script was decoration, so it was removed rather than shipped as a feature that
 * cannot work.
 *
 * What would make it work: an `ETag` over the rendered document plus `no-cache` (one conditional
 * request instead of a body), or a short `max-age` window traded against publish latency. Neither
 * is a change to make silently, and both are recorded in `docs/sds/02-errata.md` (E-48).
 */
