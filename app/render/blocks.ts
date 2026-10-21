/**
 * S8h — a plugin's data inside the page builder, drawn by the front-end it belongs to.
 *
 * The builder already has a `list` component (`schema/component-registry.json`) whose entry states the
 * contract this file implements: a `[data-repeat]` child cloned once per row, text through
 * `data-bind-<binding>`, links through `data-bind-href-<column>`, the `[data-empty]` child when
 * there are no rows, and `data-truncated` when the row cap clamped. Until now nothing resolved
 * `data-source` — dropping the component into a page produced its placeholder text — so the
 * component was a drawing of a widget rather than a widget.
 *
 * A package contributes rows, never markup (§10.5: plugin HTML does not reach a tenant's origin;
 * that is why an endpoint answers JSON). `ctx.block()` names a view over the package's own table,
 * the palette inserts the registry's `list` component with `data-source="<plugin>/<block>"`, and
 * this file fills it. The visitor sees the site's own component and the site's own CSS.
 *
 * Safety, in one place:
 *   - **Fail closed**: a source nothing claims keeps the `[data-empty]` child (or, with none, the
 *     component's own children untouched). A disabled package never 500s a page and never leaks a
 *     hint that it exists.
 *   - **Bounded**: the row count comes from the block's registration (1–20), never from the
 *     markup; identifiers are re-checked against the table's real columns before a statement.
 *   - **Escaped**: every cell is text (`data-bind-*`) or an attribute (`href`), never parsed.
 */
import type Database from 'better-sqlite3';

import { type ElementNode, type HtmlNode, attr, element, escapeAttr, escapeText, parseHtml, serialize, text } from '../editor/html.ts';
import type { DeclarativeBlock } from '../plugins/registry.ts';

/** The attribute the `list` component carries, and the one this module resolves. */
export const SOURCE_ATTR = 'data-source';
export const LIMIT_ATTR = 'data-limit';

export interface BlockLookup {
  /** The block a tenant's loaded packages registered under this id, if any. */
  (tenant: string, id: string): DeclarativeBlock | undefined;
}

interface ColumnRow {
  name: string;
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as ColumnRow[];
  return new Set(rows.map((row) => row.name));
}

/**
 * A template that is **exactly one placeholder** (`"{href}"`) means "this cell is the URL".
 *
 * That is the menu case: the row holds `/about` or `https://example.com/x`, and the segment
 * rule below would turn `/about` into `%2Fabout` — a link to nothing. A blog's `/blog/{slug}`
 * keeps the segment rule, because a slug is one path segment and must be encoded as one.
 *
 * A raw href would be an `href` a database row chooses, so `safeHref` accepts only a site
 * path (`/…`, no `//`, no `..`) or an `http(s)` URL. `javascript:`, `data:` and a bare word
 * are refused, and the caller drops the attribute rather than writing a dead link.
 */
const WHOLE_PLACEHOLDER = /^\{([a-z][a-z0-9_]*)\}$/;

function safeHref(value: string): string | null {
  if (value.startsWith('/')) {
    if (value.startsWith('//') || value.includes('..')) return null;
    return value;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** `{column}` in the block's href template, per row. `null` = no usable href for this row. */
function hrefFor(template: string, row: Record<string, unknown>): string | null {
  const whole = WHOLE_PLACEHOLDER.exec(template);
  if (whole !== null) return safeHref(String(row[whole[1] ?? ''] ?? ''));
  return template.replace(/\{([a-z][a-z0-9_]*)\}/g, (_whole, name: string) => encodeURIComponent(String(row[name] ?? '')));
}

/**
 * The rows a block asks for. Every identifier is checked against the table's real columns here
 * rather than interpolated on trust, which is the rule `crud.ts` applies to its own tables.
 */
export function blockRows(db: Database.Database, block: DeclarativeBlock): Record<string, unknown>[] {
  const actual = columnsOf(db, block.table);
  const wanted = block.columns.filter((column) => actual.has(column));
  if (wanted.length === 0) return [];
  const orderBy = block.orderBy !== undefined && actual.has(block.orderBy) ? block.orderBy : 'id';
  const direction = block.order === 'asc' ? 'ASC' : 'DESC';
  // S8m: every condition that names a real column, ANDed, up to the registry's cap of three.
  const conditions = (block.filters ?? (block.filter === undefined ? [] : [block.filter])).filter((filter) => actual.has(filter.column));
  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.map((filter) => `\"${filter.column}\" = ?`).join(' AND ')}`;
  const params: string[] = conditions.map((filter) => filter.equals);
  const limit = Math.max(1, Math.min(20, block.limit));
  const sql = `SELECT ${wanted.map((c) => `"${c}"`).join(', ')} FROM "${block.table}"${where} ORDER BY "${orderBy}" ${direction} LIMIT ${limit}`;
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

/** Replace an attribute on a node, keeping its position in the ordered list. */
function withAttr(node: ElementNode, name: string, value: string): ElementNode {
  const attrs = node.attrs.filter(([key]) => key !== name);
  return element(node.tag, [...attrs, [name, value]], node.children);
}

/** `data-repeat` marks the child cloned per row. */
function isRepeat(node: HtmlNode): node is ElementNode {
  return node.type === 'element' && attr(node, 'data-repeat') !== undefined;
}

/** `data-empty` marks the child kept when there are no rows. */
function isEmpty(node: HtmlNode): node is ElementNode {
  return node.type === 'element' && attr(node, 'data-empty') !== undefined;
}

/**
 * Apply one row to a cloned repeat child.
 *
 * Two bindings, both from the registry's `list` entry:
 *   `data-bind-<binding>="<column>"`      the element's text becomes the cell (escaped);
 *   `data-bind-href-<binding>="<column>"` the element's `href` is the block's template, filled
 *                                         from the cell. `site.url()`'s job is the template's, and
 *                                         the template is the package's own declaration.
 * A binding whose column the table does not have is left as the placeholder, so a package upgrade
 * that renames a column degrades to placeholder copy rather than an empty page.
 */
function bindRow(node: HtmlNode, block: DeclarativeBlock, row: Record<string, unknown>): HtmlNode {
  if (node.type !== 'element') return node;
  // The clone is a row, not a template any more: `data-repeat` is what marked it for cloning.
  const attrs = node.attrs.filter(([key]) => key !== 'data-repeat' && key !== 'data-empty');
  let out: ElementNode = element(node.tag, attrs, node.children.map((child) => bindRow(child, block, row)));

  for (const [key, value] of out.attrs) {
    if (!key.startsWith('data-bind-')) continue;
    const binding = key.slice('data-bind-'.length);
    if (binding.startsWith('href-')) {
      if (block.href === undefined) continue;
      if (!Object.prototype.hasOwnProperty.call(row, value)) continue;
      const href = hrefFor(block.href, row);
      // A refused href leaves the element with no `href` at all: an `<a>` with no target is
      // inert text, which is honest, and a dead or `javascript:` href is not.
      out = href === null ? element(out.tag, out.attrs.filter(([key]) => key !== 'href'), out.children) : withAttr(out, 'href', href);
      continue;
    }
    if (binding.startsWith('asset-')) continue; // no asset binding today: a plugin table holds no assets
    if (!Object.prototype.hasOwnProperty.call(row, value)) continue;
    // Text, and only text: a cell is never parsed as markup.
    out = element(out.tag, out.attrs, [text(String(row[value] ?? ''))]);
  }
  return out;
}

/**
 * Resolve every `data-source` the tenant's packages claim, in place.
 *
 * Returns the body unchanged when no marker is present, so a page with no plugin data costs one
 * `includes` call.
 *
 * ## Where the repeat child may sit (S8m)
 *
 * `[data-repeat]` must be reachable from the `data-source` element by descending through
 * **single-element wrappers** — `children.length` of elements == 1 at each step, at most three
 * steps. That is what lets a menu be a `<ul>` of `<li>`s:
 *
 *     <div data-source="menu/menu-main"><ul><li data-repeat>…</li></ul><p data-empty>…</p></div>
 *
 * The first version only looked at direct children, so a block whose markup used a list
 * wrapper resolved to nothing at all — the page kept the raw marker and the editor saw a
 * block that "did nothing". The `<ul>` is not decoration: a menu without it is a run of
 * links with no list semantics for a screen reader.
 */
export function resolveSourceBlocks(db: Database.Database, tenant: string, html: string, lookup: BlockLookup): string {
  if (!html.includes(SOURCE_ATTR)) return html;
  let changed = false;

  /** The chain of single-element wrappers from `node` down to the element holding the repeat. */
  function findHolder(node: ElementNode): { chain: { node: ElementNode; index: number }[]; holder: ElementNode } | null {
    let holder = node;
    const chain: { node: ElementNode; index: number }[] = [];
    for (;;) {
      if (holder.children.some(isRepeat)) return { chain, holder };
      // The `data-empty` child is not content: it is the no-rows fallback that sits beside the
      // wrapper, so counting it as a candidate would stop the descent at a div with one
      // wrapper and one empty-paragraph.
      const elements = holder.children
        .map((child, index) => ({ child, index }))
        .filter(({ child }) => child.type === 'element' && !isEmpty(child));
      if (elements.length !== 1 || chain.length >= 3) return null;
      const only = elements[0] as { child: ElementNode; index: number };
      chain.push({ node: holder, index: only.index });
      holder = only.child;
    }
  }

  const walk = (nodes: HtmlNode[]): HtmlNode[] =>
    nodes.map((node) => {
      if (node.type !== 'element') return node;
      const source = attr(node, SOURCE_ATTR);
      if (source === undefined) return element(node.tag, node.attrs, walk(node.children));

      const block = lookup(tenant, source);
      if (block === undefined) return element(node.tag, node.attrs, walk(node.children));

      const found = findHolder(node);
      const repeatIndex = found === null ? -1 : found.holder.children.findIndex(isRepeat);
      if (found === null || repeatIndex === -1) return node;

      changed = true;
      const rows = blockRows(db, block);
      const emptyIndex = node.children.findIndex(isEmpty);

      // A clamped limit is stated in the markup, as the registry entry promises.
      const clamped = block.limit > 20 ? 20 : block.limit;
      const truncated = block.limit > clamped ? withAttr(node, 'data-truncated', '1') : node;
      const base = withAttr(truncated, LIMIT_ATTR, String(clamped));

      const template = found.holder.children[repeatIndex] as ElementNode;
      const itemChildren: HtmlNode[] =
        rows.length === 0
          ? found.holder.children.filter((child, index) => index !== repeatIndex)
          : [...rows.map((row) => bindRow(template, block, row)), ...found.holder.children.filter((_child, index) => index !== repeatIndex)];

      // Rebuild the wrapper chain bottom-up, then drop the `data-empty` child when rows exist.
      let built: ElementNode = element(found.holder.tag, found.holder.attrs, itemChildren);
      for (let i = found.chain.length - 1; i >= 0; i -= 1) {
        const link = found.chain[i] as { node: ElementNode; index: number };
        built = element(
          link.node.tag,
          link.node.attrs,
          link.node.children.map((child, index) => (index === link.index ? built : child)),
        );
      }

      if (rows.length === 0 && emptyIndex === -1) {
        return element(built.tag, built.attrs, [
          ...built.children,
          element('p', [['class', 'list__empty']], [text('Nothing to show yet.')]),
        ]);
      }
      if (rows.length === 0) return element(built.tag, built.attrs, built.children);
      // Drop the `data-empty` child by what it IS, not by where it was: N clones were inserted
      // in front of it, so its old index now points at a row. (That bug shipped once: a block
      // with rows dropped its first row instead of its empty paragraph.)
      return element(built.tag, built.attrs, built.children.filter((child) => !isEmpty(child)));
    });

  const resolved = walk(parseHtml(html));
  return changed ? serialize(resolved) : html;
}
