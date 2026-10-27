/**
 * S8k — a package's detail page, and a package's form, both drawn by the host.
 *
 * Two dead ends this file closes:
 *
 *   1. **`/blog/test` answered 404 while the post existed.** This CMS serves `cms_page` rows by
 *      path; a post is a row in `p_blog_post`, so the list block linked somewhere nothing could
 *      answer. A package now declares the *shape* of a detail page — a pattern, its table, and
 *      which columns are the slug, the title and the body — and the host renders it through the
 *      ordinary page path (same shell, same nav, same filters). The package supplies no markup:
 *      the title and body are escaped text, paragraphs split on blank lines.
 *
 *   2. **A form nobody could fill in.** `/_plugin/<id>/<endpoint>` is JSON by contract, so a
 *      browser form cannot post there and get a page back. The host draws the form from the
 *      package's declaration, posts it to the page's own path, and forwards the fields to the
 *      endpoint as JSON — the same split the admin login uses for its own form.
 */
import type Database from 'better-sqlite3';

import { type HtmlNode, attr, element, escapeAttr, escapeText, parseHtml, serialize } from '../editor/html.ts';
import type { DeclarativeForm, DeclarativePage } from '../plugins/registry.ts';

export interface PageMatch {
  page: DeclarativePage;
  /** The placeholder's value, already decoded. */
  slug: string;
}

/**
 * `/blog/{slug}` → a matcher. One placeholder, so one capture group.
 *
 * The placeholder is replaced **after** the regex metacharacters are escaped, and `{`/`}` are not
 * among them — escaping them first made the replacement look for a literal backslash and never
 * match, so every post page answered 404 (found by S8k-1, which is why it exists).
 */
function matcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\{[a-z][a-z0-9_]*\}/, '([^/]+)')}$`);
}

/**
 * The declared page that answers this path, if any. Longest pattern first: a package that declares
 * both `/blog/{slug}` and `/blog/authors/{slug}` must not have the shorter one win in a coin flip.
 */
export function matchPluginPage(
  pages: Iterable<DeclarativePage>,
  path: string,
): PageMatch | undefined {
  const ordered = [...pages].sort((a, b) => b.pattern.length - a.pattern.length);
  for (const page of ordered) {
    const m = matcher(page.pattern).exec(path);
    if (m === null) continue;
    try {
      return { page, slug: decodeURIComponent(m[1] as string) };
    } catch {
      return undefined; // a malformed escape is not a post
    }
  }
  return undefined;
}

/**
 * The row behind a detail page.
 *
 * Identifiers are re-checked against the table's own columns rather than trusted from the manifest:
 * a package that renamed a column in an upgrade must degrade to "no such post", not to a SQL error
 * on a public URL.
 */
export function loadPluginPage(
  db: Database.Database,
  page: DeclarativePage,
  slug: string,
): Record<string, unknown> | undefined {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info("${page.table}")`).all() as { name: string }[]).map((c) => c.name),
  );
  const wanted = [page.slugColumn, page.titleColumn, page.bodyColumn].filter((c) => columns.has(c));
  if (wanted.length < 3) return undefined;
  const filterColumn = page.filter !== undefined && columns.has(page.filter.column) ? page.filter.column : undefined;
  const where = filterColumn === undefined ? '' : ` AND "${filterColumn}" = ?`;
  // Bind order follows the statement: the slug is the first `?`, the filter's value the second.
  const params: unknown[] = [slug];
  if (filterColumn !== undefined) params.push(page.filter?.equals ?? '');
  return db
    .prepare(`SELECT ${wanted.map((c) => `"${c}"`).join(', ')} FROM "${page.table}" WHERE "${page.slugColumn}" = ?${where} LIMIT 1`)
    .get(...params) as Record<string, unknown> | undefined;
}

/** The host's markup for a detail page: a title and escaped paragraphs. */
export function pluginPageBody(row: Record<string, unknown>, page: DeclarativePage): string {
  const title = escapeText(String(row[page.titleColumn] ?? ''));
  const paragraphs = String(row[page.bodyColumn] ?? '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => `<p>${escapeText(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return `<article class="skw-post">\n<h1>${title}</h1>\n${paragraphs}\n</article>`;
}

/**
 * The form a package declared, as host markup — see `pluginFormHtml` below.
 *
 * The words a **page** may say instead of the package's defaults: submit label, one label per
 * field, and the sentence after a successful send.
 *
 * Copy is the product, and a package is generic — the contact package calls its third field
 * "Message", while the page it is dropped into may want "What's broken?". Structure belongs to
 * the package (what fields exist, where they post); wording belongs to the page (what this site
 * says to its own visitors). The page supplies it as attributes on the marker, so the saved body
 * still carries no form markup.
 */
export interface FormCopy {
  labels?: ReadonlyMap<string, string>;
  submit?: string;
  thanks?: string;
}

/** Attribute prefixes a marker may use. `data-skw-label-message="What's broken?"`. */
const COPY_LABEL_PREFIX = 'data-skw-label-';
const COPY_SUBMIT = 'data-skw-submit';
const COPY_THANKS = 'data-skw-thanks';
const LABEL_MAX = 120;
const THANKS_MAX = 300;

/** Text from a page is escaped at render (never trusted), and capped so one page cannot bloat a form. */
function capped(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Replace `[data-skw-form]` markers with the form the package declared.
 *
 * The palette inserts the marker, not the form: the form's state (`sent`, an error sentence) is
 * known at render time and nowhere else, and a marker keeps the saved page free of a message that
 * was true for one visitor.
 */
export function resolveFormMarkers(
  html: string,
  lookup: (id: string) => DeclarativeForm | undefined,
  opts: { sent?: boolean; error?: string } = {},
): string {
  if (!html.includes('data-skw-form')) return html;
  const tree = parseHtml(html);
  let changed = false;
  const walk = (nodes: HtmlNode[]): HtmlNode[] =>
    nodes.map((node) => {
      if (node.type !== 'element') return node;
      const id = attr(node, 'data-skw-form');
      if (id === undefined) return element(node.tag, node.attrs, walk(node.children));
      const form = lookup(id);
      if (form === undefined) return node; // fail closed: an unknown form draws nothing extra
      changed = true;
      return element('div', [['class', 'skw-form__wrap']], parseHtml(pluginFormHtml(form, opts, copyOf(node.attrs))));
    });
  const out = walk(tree);
  return changed ? serialize(out) : html;
}

/** The marker's own wording, read off its attributes. Absent attributes fall back to the package. */
function copyOf(attrs: readonly (readonly [string, string])[]): FormCopy {
  const labels = new Map<string, string>();
  let submit: string | undefined;
  let thanks: string | undefined;
  for (const [name, value] of attrs) {
    if (name === COPY_SUBMIT) submit = capped(value, LABEL_MAX);
    else if (name === COPY_THANKS) thanks = capped(value, THANKS_MAX);
    else if (name.startsWith(COPY_LABEL_PREFIX)) {
      const field = name.slice(COPY_LABEL_PREFIX.length);
      if (/^[a-z][a-z0-9_]{0,40}$/.test(field)) labels.set(field, capped(value, LABEL_MAX));
    }
  }
  return { labels, ...(submit === undefined || submit === '' ? {} : { submit }), ...(thanks === undefined || thanks === '' ? {} : { thanks }) };
}

/**
 * The markup for a declared form.
 *
 * No `action`: a form with no action posts to the URL it is on, which is exactly right — the page
 * path is the form's endpoint, and the host forwards. The package's id travels in a hidden field,
 * and the visitor's values are the only other thing that does.
 */
export function pluginFormHtml(
  form: DeclarativeForm,
  opts: { error?: string; sent?: boolean } = {},
  copy: FormCopy = {},
): string {
  if (opts.sent === true) {
    const thanks = copy.thanks ?? form.thanks;
    return `<p class="skw-form__thanks" role="status">${escapeText(thanks)}</p>`;
  }
  const fields = form.fields
    .map((field) => {
      const id = `f_${form.id.replace(/[^a-z0-9]+/gi, '-')}-${field.name}`;
      const common = `id="${escapeAttr(id)}" name="${escapeAttr(field.name)}"${field.required === true ? ' required' : ''}${
        field.maxLength === undefined ? '' : ` maxlength="${field.maxLength}"`
      }`;
      const label = copy.labels?.get(field.name) ?? field.label;
      const control =
        field.type === 'textarea'
          ? `<textarea ${common} rows="5"></textarea>`
          : `<input ${common} type="${field.type === 'email' ? 'email' : 'text'}">`;
      return `<div class="field"><label for="${escapeAttr(id)}">${escapeText(label)}</label>${control}</div>`;
    })
    .join('\n');
  const error = opts.error === undefined ? '' : `<p class="skw-form__error" role="alert">${escapeText(opts.error)}</p>`;
  const submit = copy.submit ?? 'Send';
  return `<form method="post" class="skw-form fields" data-skw-form="${escapeAttr(form.id)}">
<input type="hidden" name="_skw_form" value="${escapeAttr(form.id)}">
${error}
${fields}
<button type="submit">${escapeText(submit)}</button>
</form>`;
}
