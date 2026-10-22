/**
 * The tenant's stylesheet as a **response**, not as an inline `<style>` (S8o).
 *
 * ## The defect this fixes
 *
 * The shell used to interpolate its stylesheets into the document — one `<style>` for the chrome
 * and one for `cms_page.body_css`. The site's CSP is `style-src 'self'` with no inline allowance
 * (C-12, frozen in four files and compared by hash), so a real browser **blocked both**. In a
 * browser, therefore, every tenant page rendered with no chrome layout and no per-page styling at
 * all: `position: sticky` was dead, the bar did not space itself, and a page's own CSS never
 * applied. curl showed the markup and every test until now read the markup, which is why nothing
 * caught it. It was found by looking at a screenshot of the site — the one check that ran the
 * policy's own consumer.
 *
 * ## The fix that does not touch the policy
 *
 * `style-src 'self'` allows a stylesheet **from this origin**. So `chromeCss(chrome)` and the site
 * theme (`site.theme_css`) are concatenated here and served at `/theme.css`, and the shell links
 * them. No
 * `'unsafe-inline'`, no hash list that has to be recomputed on every settings change, and the
 * browser caches one file per page instead of re-parsing the same 10 KB in every document.
 *
 * ## Caching
 *
 * The URL names the page, so a per-page sheet cannot be served for the wrong page; the `ETag` is
 * the sha256 of the bytes, so an edit to the theme or to that page's CSS changes it. `max-age=0,
 * must-revalidate` means a returning visitor makes one conditional request and gets a `304` — a
 * page whose CSS has not changed costs a header exchange, not a body.
 */
import { createHash } from 'node:crypto';

import { chromeCss, themeCss, type SiteChrome } from './chrome.ts';

export interface SheetInput {
  /** `null` on a tenant that has never set any chrome. */
  chrome: SiteChrome | null;
  /**
   * True when the document being served has a bar or a footer. `chromeCss` is only worth
   * emitting then; a tenant with settings but no bar has nothing for those rules to select.
   */
  showChrome: boolean;
}

/**
 * The site's stylesheet: the chrome's rules first, then the site theme.
 *
 * Order matters and is the CSS cascade's, not ours: the theme is written after the chrome's
 * defaults so a site can restyle its own bar without `!important`.
 *
 * A page's own `body_css` is deliberately **not** here. It is still emitted inline by the shell,
 * because the exported static tree (`app/export/document.ts`) does the same and the two are
 * compared byte-for-byte by `test/export-targets.test.ts`. One answer to "where does a page's CSS
 * live" is worth more than a second URL scheme; the consequence — a page's own CSS is still
 * subject to `style-src 'self'` — is recorded in `docs/sds/02-errata.md` (E-41).
 */
export function siteSheet(input: SheetInput): string {
  const parts: string[] = [];
  if (input.chrome !== null && input.showChrome) parts.push(chromeCss(input.chrome));
  if (input.chrome !== null) {
    const theme = themeCss(input.chrome);
    if (theme !== '') parts.push(theme);
  }
  return parts.join('\n');
}

/**
 * The stylesheet's version token, for the URL: the first twelve hex characters of the same
 * sha256 the `ETag` carries.
 *
 * Why the URL and not just the `ETag`: a `max-age=0, must-revalidate` sheet makes every
 * navigation a conditional request, and the browser cannot paint until the answer arrives —
 * the stylesheet is render-blocking, so one revalidation is one round trip in front of the
 * first pixel of every click. Naming the bytes in the URL lets the same file be cached for a
 * year, and changes the URL when the bytes change, which is the only thing that makes a long
 * cache safe on a file an operator edits.
 */
export function sheetVersion(sheet: string): string {
  return createHash('sha256').update(sheet, 'utf8').digest('hex').slice(0, 12);
}

/** A strong ETag for a sheet: the sha256 of exactly the bytes that will be sent. */
export function sheetEtag(sheet: string): string {
  return `"${createHash('sha256').update(sheet, 'utf8').digest('hex').slice(0, 32)}"`;
}

/**
 * Does `If-None-Match` cover this ETag?
 *
 * Accepts a list (`"a", "b"`) and the weak form (`W/"a"`), because those are what browsers send
 * after a reload. A `*` matches anything, per RFC 9110.
 */
export function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined || ifNoneMatch === '') return false;
  return ifNoneMatch
    .split(',')
    .map((part) => part.trim().replace(/^W\//, ''))
    .some((part) => part === etag || part === '*');
}
