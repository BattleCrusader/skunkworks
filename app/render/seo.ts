/**
 * Per-page search metadata, from `cms_page.seo_json` to the `<head>`.
 *
 * The column has existed since the page table was written and nothing read it, which is why a
 * site could have a title and nothing else: a crawlable page needs a description, a canonical URL
 * and a share card, and none of those belong in a body that refuses `<script>` by design.
 *
 * ## Why this is not a plugin
 *
 * It was written as one first — a package owning `p_<id>_page` and answering the `page.head` filter
 * from its own table. That cannot work, and the reason is worth writing down: a hook callback
 * receives `(call, value)` and **nothing else**. The `ctx` handed to `activate()` closes when
 * activation ends, so a `page.head` callback has no store to read and no per-request facade; the
 * only data it can see is the call payload the host chose to pass. A package that "reads the
 * database at render time" would have to cache every row at activation and go stale silently.
 * So per-page metadata lives where the page's own row already is.
 *
 * ## What is emitted, and when
 *
 * Nothing at all when `seo_json` is absent or empty — a site that has not filled it in renders the
 * same bytes it rendered before this existed, which is what keeps the export comparison honest.
 * When it is present: description, an absolute canonical (only when an origin is known), Open
 * Graph and Twitter cards, and a JSON-LD document if the JSON parses. Every `<` inside the JSON is
 * written `\u003c`, so a value cannot close the script element it lives in.
 */

export interface PageSeo {
  /** Social title. The document title is emitted by the shell and is not repeated here. */
  title?: string;
  /** The meta description: one sentence, 120-158 characters is the useful range. */
  description?: string;
  /** An absolute canonical URL. Overrides `<origin><path>`. */
  canonical?: string;
  /** An absolute image URL for the share card. */
  image?: string;
  /** A JSON-LD document, as an object. */
  jsonLd?: unknown;
}

/** The largest head a page may carry from this module. A page is not a bundle. */
export const SEO_HEAD_MAX = 16 * 1024;

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * `seo_json` → an object, or null. A malformed column is treated as absent rather than as a
 * render failure: a page whose body is fine must not 500 because a metadata box holds a stray
 * comma, and the operator's screen refuses to save invalid JSON in the first place.
 */
export function parsePageSeo(raw: string | null | undefined): PageSeo | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const seo: PageSeo = {};
  for (const key of ['title', 'description', 'canonical', 'image'] as const) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') seo[key] = value.trim();
  }
  if (source.jsonLd !== undefined && source.jsonLd !== null) seo.jsonLd = source.jsonLd;
  return Object.keys(seo).length === 0 ? null : seo;
}

export interface SeoHeadInput {
  seo: PageSeo;
  /** The page's path, used for the canonical when the seo document does not name one. */
  path: string;
  /** The document title already in `<title>`, used where a card needs a title. */
  documentTitle: string;
  /** The site's own name, for `og:site_name`. */
  siteName: string;
  /** `https://host`, or null when the request carried no host worth trusting. */
  origin: string | null;
}

/** A JSON-LD document as text that cannot terminate its own script element. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** The head markup for one page, or `''` when the page carries no SEO document. */
export function pageSeoHead(input: SeoHeadInput): string {
  const { seo, path, documentTitle, siteName, origin } = input;
  const parts: string[] = [];

  const canonical = seo.canonical ?? (origin === null ? null : `${origin}${path === '/' ? '/' : path}`);
  const title = seo.title ?? (documentTitle === '' ? null : documentTitle);

  if (seo.description !== undefined) {
    parts.push(`<meta name="description" content="${attr(seo.description)}">`);
    parts.push(`<meta property="og:description" content="${attr(seo.description)}">`);
    parts.push(`<meta name="twitter:description" content="${attr(seo.description)}">`);
  }
  if (canonical !== null) parts.push(`<link rel="canonical" href="${attr(canonical)}">`);
  if (title !== null) {
    parts.push(`<meta property="og:title" content="${attr(title)}">`);
    parts.push(`<meta name="twitter:title" content="${attr(title)}">`);
  }
  parts.push('<meta property="og:type" content="website">');
  parts.push('<meta property="og:locale" content="en_AU">');
  if (siteName !== '') parts.push(`<meta property="og:site_name" content="${attr(siteName)}">`);
  if (canonical !== null) parts.push(`<meta property="og:url" content="${attr(canonical)}">`);
  if (seo.image !== undefined) {
    parts.push(`<meta property="og:image" content="${attr(seo.image)}">`);
    parts.push(`<meta name="twitter:image" content="${attr(seo.image)}">`);
  }
  parts.push(`<meta name="twitter:card" content="${seo.image === undefined ? 'summary' : 'summary_large_image'}">`);
  if (seo.jsonLd !== undefined) {
    parts.push(`<script type="application/ld+json">${scriptSafeJson(seo.jsonLd)}</script>`);
  }

  const head = parts.join('');
  if (head.length > SEO_HEAD_MAX) return '';
  return head;
}

/** `https://host` from a request's Host header, or null. A port is not part of a canonical. */
export function originFromHost(host: string | undefined): string | null {
  if (typeof host !== 'string' || host === '') return null;
  const bare = host.split(':')[0] ?? '';
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(bare)) return null;
  return `https://${bare}`;
}

/** Exposed for a caller that wants the escaping the two helpers above share. */
export { esc as escapeHeadText };
