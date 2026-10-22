/**
 * The document shell — **one serialiser, three targets** (§11.1, D22).
 *
 * The site's shell is `app/render/components/shells/page.astro`. Astro renders it in
 * `compressHTML: false` mode, which preserves the template's own whitespace and
 * rewrites the two void elements it is given. The bytes it produces are therefore a
 * pure function of `{tenantKey, path, title, bodyCss, bodyHtml}`, and this file is the
 * same function written once so the static and Astro exports can emit the site's
 * document rather than a lookalike:
 *
 *     <!DOCTYPE html>
 *     <html lang="en" data-tenant="acme">
 *       <head>
 *         <meta charset="utf-8">
 *         <meta name="viewport" content="width=device-width, initial-scale=1">
 *     <title>About us</title><link rel="stylesheet" href="/_css/<sha256>.css">
 *       </head>
 *       <body data-page-path="/about">
 *         <main>…body…</main>
 *       </body>
 *     </html>
 *
 * `test/export-targets.test.ts` asserts this byte-for-byte against the live site's
 * response for the same page, so a change to `page.astro` that this file does not mirror
 * is a red gate — not a cosmetic drift someone notices in production.
 *
 * Escaping: Astro escapes an expression in text position with `&`, `<`, `>` (and the
 * quotes, which it also escapes in attributes). `escapeHtml` is the same five-character
 * set, applied to the title and to the two attribute values; `bodyHtml` and `bodyCss`
 * are inserted raw because they are the stored content (the schema refuses `<script`,
 * `<style`, `<!--`, `javascript:` and `srcdoc` in `body_html`).
 */

import { createHash } from 'node:crypto';

/** The five characters Astro's expression escaping covers, as one function. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * S8s: the page's CSS is a file, not a `<style>` element — the policy's `style-src 'self'` blocks
 * an inline one in a browser (E-41), and a content-addressed name is the only URL that can be
 * cached for a year without asking again (E-48). The name is the sha256 of the bytes, so the live
 * route (`/_css/:file`) and this document compute it the same way from the same string.
 */
export function pageCssPath(css: string): string {
  return `/_css/${createHash('sha256').update(css, 'utf8').digest('hex')}.css`;
}

export interface DocumentInput {
  tenantKey: string;
  path: string;
  title: string;
  bodyHtml: string;
  bodyCss: string;
}

/**
 * The document, exactly as the site's Astro shell emits it. No trailing newline: the
 * template's last line ends at `</html>` and Astro adds none, and a byte is a byte.
 *
 * The empty-CSS case is not cosmetic: the shell's `{ownSheetHref !== null ? … : null}` sits
 * immediately after `</title>`, and Astro leaves nothing behind when it is null. Measured, not
 * assumed: a document is compared byte for byte with the live response, so a stray space is a red
 * gate rather than a cosmetic drift.
 */
export function renderDocument(input: DocumentInput): string {
  const style = input.bodyCss === '' ? '' : `<link rel="stylesheet" href="${pageCssPath(input.bodyCss)}">`;
  return (
    `<!DOCTYPE html>\n` +
    `<html lang="en" data-tenant="${escapeHtml(input.tenantKey)}">\n` +
    `  <head>\n` +
    `    <meta charset="utf-8">\n` +
    `    <meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `    <title>${escapeHtml(input.title)}</title>` +
    style +
    `\n  </head>\n` +
    `  <body data-page-path="${escapeHtml(input.path)}">\n` +
    `    <main>${input.bodyHtml}</main>\n` +
    `  </body>\n` +
    `</html>`
  );
}
