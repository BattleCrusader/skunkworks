/**
 * S8h — plugin blocks in a page body.
 *
 * A package owns data; the host owns markup. That split is why an endpoint answers JSON and why
 * `admin.render.html` does not exist (§13.3.4, §10.5): plugin HTML on the tenant's origin is a
 * decision the CSP does not make in v1. So a *block* is the package naming a view over its own
 * table — columns, order, one equality filter, a link shape — and this file drawing it.
 *
 * Three properties this file must hold:
 *
 *  1. **Fail closed.** A marker naming a block that is not registered (a disabled package, a
 *     package that was uninstalled, a typo in a body) renders nothing at all. A page never 500s
 *     because a package is gone, and never leaks "there is a blog plugin here" to a visitor.
 *  2. **Bounded.** The row limit was capped at registration (1–20), the columns were checked
 *     against the manifest, and every identifier is re-checked here against the table's own
 *     columns before it reaches a statement. Nothing in `body_html` can change what is queried:
 *     the marker carries only the block id, and every other attribute is ignored.
 *  3. **Escaped.** Every value read from the table is escaped for text and for attribute context.
 *     The package writes the data; the host writes the HTML around it.
 */
import type Database from 'better-sqlite3';

import { type HtmlNode, attr, element, escapeAttr, escapeText, parseHtml, serialize, text } from '../editor/html.ts';
import type { DeclarativeBlock } from '../plugins/registry.ts';

/** The attribute the editor writes and this module consumes. */
export const BLOCK_ATTR = 'data-skw-block';

/** The class every generated block carries, so a theme can style one without a new component. */
const BLOCK_CLASS = 'skw-block';

export interface BlockLookup {
  /** The block a tenant's loaded packages registered under this id, if any. */
  (tenant: string, id: string): DeclarativeBlock | undefined;
}

interface ColumnRow {
  name: string;
  type: string;
}

function columnsOf(db: Database.Database, table: string): Map<string, string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as ColumnRow[];
  return new Map(rows.map((row) => [row.name, row.type]));
}

/** `{column}` in an href, replaced per row. An unknown token is left as written. */
function hrefFor(template: string, row: Record<string, unknown>): string {
  return template.replace(/\{([a-z][a-z0-9_]*)\}/g, (_whole, name: string) =>
    encodeURIComponent(String(row[name] ?? '')),
  );
}

/** One row's visible text: the label column, or the first column. */
function labelOf(block: DeclarativeBlock, row: Record<string, unknown>): string {
  return String(row[block.labelColumn ?? block.columns[0] as string] ?? '');
}

/**
 * The rows a block asks for, as plain objects.
 *
 * The statement is built from the block's own validated identifiers and the table's real columns:
 * an identifier that is not a column of the table is refused here rather than interpolated, which
 * is the same rule `crud.ts` applies to its own tables.
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

/** The host's markup for one block. No package bytes ever reach this string. */
export function renderBlock(db: Database.Database, block: DeclarativeBlock): string {
  const rows = blockRows(db, block);
  if (rows.length === 0) {
    // An empty block says so in a comment, not in copy: an operator reading the page source can
    // see it ran, and a visitor is not told a plugin exists and had nothing to say.
    return `<!-- skw-block ${escapeText(block.id)}: no rows -->`;
  }
  const extra = block.columns.filter((column) => column !== (block.labelColumn ?? block.columns[0]));
  const title = (row: Record<string, unknown>): string => {
    const text_ = escapeText(labelOf(block, row));
    if (block.href === undefined) return text_;
    return `<a href="${escapeAttr(hrefFor(block.href, row))}">${text_}</a>`;
  };

  if (block.layout === 'cards') {
    const cards = rows
      .map((row) => {
        const detail = extra
          .map((column) => `<p class="skw-block__meta">${escapeText(String(row[column] ?? ''))}</p>`)
          .join('');
        return `<article class="${BLOCK_CLASS}__card"><h3>${title(row)}</h3>${detail}</article>`;
      })
      .join('\n');
    return `<section class="${BLOCK_CLASS} ${BLOCK_CLASS}--cards">\n${cards}\n</section>`;
  }
  const items = rows
    .map((row) => {
      const detail = extra
        .map((column) => `<span class="skw-block__meta">${escapeText(String(row[column] ?? ''))}</span>`)
        .join(' ');
      return `<li>${title(row)}${detail === '' ? '' : ` ${detail}`}</li>`;
    })
    .join('\n');
  return `<section class="${BLOCK_CLASS}">\n<ul>\n${items}\n</ul>\n</section>`;
}

/**
 * Replace every `data-skw-block` element in a body with the block's markup.
 *
 * The generated markup is parsed back into nodes and spliced in, rather than string-spliced, so
 * the result is a well-formed tree and nesting inside the marker (GrapesJS sometimes leaves a
 * wrapper) cannot break the page's structure.
 */
export function resolveBlocks(
  db: Database.Database,
  tenant: string,
  html: string,
  lookup: BlockLookup,
): string {
  if (!html.includes(BLOCK_ATTR)) return html;
  let changed = false;

  const walk = (nodes: HtmlNode[]): HtmlNode[] => {
    const out: HtmlNode[] = [];
    for (const node of nodes) {
      if (node.type !== 'element') {
        out.push(node);
        continue;
      }
      const id = attr(node, BLOCK_ATTR);
      if (id === undefined) {
        out.push(element(node.tag, node.attrs, walk(node.children)));
        continue;
      }
      const block = lookup(tenant, id);
      // Fail closed: nothing to draw, nothing drawn.
      if (block === undefined) {
        changed = true;
        continue;
      }
      changed = true;
      out.push(...parseHtml(renderBlock(db, block)));
    }
    return out;
  };

  const resolved = walk(parseHtml(html));
  return changed ? serialize(resolved) : html;
}

/** The marker the editor inserts for a block. One function, so palette and renderer agree. */
export function blockMarker(id: string): string {
  return `<div class="${BLOCK_CLASS}" ${BLOCK_ATTR}="${escapeAttr(id)}"></div>`;
}

export { BLOCK_CLASS };
