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

/** `{column}` in the block's href template, per row. */
function hrefFor(template: string, row: Record<string, unknown>): string {
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
  const filterColumn = block.filter !== undefined && actual.has(block.filter.column) ? block.filter.column : undefined;
  const where = filterColumn === undefined ? '' : ` WHERE "${filterColumn}" = ?`;
  const params = filterColumn === undefined ? [] : [block.filter?.equals ?? ''];
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
      out = withAttr(out, 'href', hrefFor(block.href, row));
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
 */
export function resolveSourceBlocks(db: Database.Database, tenant: string, html: string, lookup: BlockLookup): string {
  if (!html.includes(SOURCE_ATTR)) return html;
  let changed = false;

  const walk = (nodes: HtmlNode[]): HtmlNode[] =>
    nodes.map((node) => {
      if (node.type !== 'element') return node;
      const source = attr(node, SOURCE_ATTR);
      if (source === undefined) return element(node.tag, node.attrs, walk(node.children));

      const block = lookup(tenant, source);
      if (block === undefined) return element(node.tag, node.attrs, walk(node.children));

      changed = true;
      const rows = blockRows(db, block);
      const repeatIndex = node.children.findIndex(isRepeat);
      const emptyIndex = node.children.findIndex(isEmpty);
      if (repeatIndex === -1) return node;

      const template = node.children[repeatIndex] as ElementNode;
      // A clamped limit is stated in the markup, as the registry entry promises.
      const clamped = block.limit > 20 ? 20 : block.limit;
      const base = withAttr(node, LIMIT_ATTR, String(clamped));
      const truncated = block.limit > clamped ? withAttr(base, 'data-truncated', '1') : base;

      if (rows.length === 0) {
        const kept = truncated.children.filter((child, index) => index === emptyIndex || !isRepeat(child));
        return element(truncated.tag, truncated.attrs, kept.length === 0
          ? [element('p', [['class', 'list__empty']], [text('Nothing to show yet.')])]
          : kept);
      }

      const items: HtmlNode[] = rows.map((row) => bindRow(template, block, row));
      const rest = truncated.children.filter((child, index) => index !== repeatIndex && index !== emptyIndex);
      return element(base.tag, base.attrs, [...items, ...rest]);
    });

  const resolved = walk(parseHtml(html));
  return changed ? serialize(resolved) : html;
}
