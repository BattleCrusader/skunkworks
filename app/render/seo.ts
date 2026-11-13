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
 *
 * ## `robots`, and why `index` is never stored
 *
 * One key is a *control* rather than metadata: `"robots": "noindex"` is the page an operator has
 * decided search engines should not list. It rides in the same column instead of a new one because
 * `seo_json` is already on every page row, already carried by the render, and already written by
 * no other code — a column would be a schema amendment for a single enum.
 *
 * `"index"` is the default and is therefore **not representable**: `parsePageSeo` drops it, and
 * the writer removes the key. That is what keeps criterion "an indexable page is byte-unchanged"
 * true — a page that has never been touched carries no `robots` key, produces no `<meta
 * name="robots">`, and renders precisely the bytes it rendered before this existed.
 */

/** What an operator chooses in the Pages screen. `index` is the default. */
export type PageRobots = 'index' | 'noindex';

export interface PageSeo {
  /** Social title. The document title is emitted by the shell and is not repeated here. */
  title?: string;
  /** The meta description: one sentence, 120-158 characters is the useful range. */
  description?: string;
  /** An absolute canonical URL. Overrides `<origin><path>`. */
  canonical?: string;
  /** An absolute image URL for the share card. */
  image?: string;
  /**
   * `'noindex'` only. Absent means indexable, and `'index'` in the stored JSON is normalised away
   * so that writing "yes, index this" cannot change a document's bytes.
   */
  robots?: 'noindex';
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
  // `'index'` is the default and is deliberately not representable: storing it would be a no-op
  // that changed the document's bytes (this object would no longer be empty, so `pageSeoHead`
  // would start emitting a card for a page that had none).
  if (source.robots === 'noindex') seo.robots = 'noindex';
  return Object.keys(seo).length === 0 ? null : seo;
}

/** The page's search-engine visibility, with `seo_json` missing or malformed read as indexable. */
export function pageRobots(raw: string | null | undefined): PageRobots {
  return parsePageSeo(raw)?.robots === 'noindex' ? 'noindex' : 'index';
}

/** The result of setting one page's visibility: the new column value, or why it was refused. */
export type PageRobotsWrite = { ok: true; json: string | null } | { ok: false; reason: string };

/**
 * `seo_json` with `robots` set (or removed, for `'index'`), for the write path.
 *
 * Every other key is preserved verbatim, including ones this module does not understand — the
 * column is the operator's data and a visibility toggle is not licence to drop a key. An empty
 * result becomes `null` so the column stays NULL for a page with no metadata at all, which is the
 * state every page row starts in.
 *
 * Invalid JSON is **refused** rather than overwritten: an operator who hand-edited the column into
 * a syntax error should be told, not have their typing replaced by the toggle they pressed.
 */
export function withPageRobots(raw: string | null | undefined, robots: PageRobots): PageRobotsWrite {
  let source: Record<string, unknown> = {};
  if (typeof raw === 'string' && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'seo_json is not JSON' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'seo_json is not an object' };
    }
    source = { ...(parsed as Record<string, unknown>) };
  }
  if (robots === 'noindex') source.robots = 'noindex';
  else delete source.robots;
  return { ok: true, json: Object.keys(source).length === 0 ? null : JSON.stringify(source) };
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

  // First, because it decides whether anything after it is read at all. `follow` is left to the
  // document: hiding a page from the index is not a claim that its links are untrustworthy, and a
  // crawler that stops following here would also stop finding the pages it may index.
  if (seo.robots === 'noindex') parts.push('<meta name="robots" content="noindex">');
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
