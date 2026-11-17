/**
 * A package's screen, when the package says it is something to *work through* rather than a table
 * to browse: rows you can narrow, tick and act on, and a count you can see from anywhere.
 *
 * Nothing here knows what a message is. Every product decision — which column carries a state,
 * what the states are called, what the buttons say, what a delete warns about, which column is the
 * preview, what the counter counts — is declared by the package through `ctx.screen()` and
 * validated at activation (`registry.ts`). This module reads those declarations and answers
 * questions about rows: how many are in each state, which page is on the screen, how many match a
 * search.
 *
 * **Reads only.** The writes stay where they always were — `updateRow` / `deleteRow`, one row at a
 * time with its own audit row — because a bulk action that skipped the audit trail would be a way
 * to change a record with no record of the change. The route loops them over the ids it was given.
 *
 * **Writes and reads are separate functions on purpose.** A badge is drawn on pages that have no
 * business loading a page of rows, so `countBadge` answers one integer and is called from the app
 * bar; `readManaged` is called only by the screen itself.
 */
import type Database from 'better-sqlite3';
import type { DeclarativeScreen, ScreenAction } from '../plugins/registry.ts';
import { describeTable } from './crud.ts';

/** Rows per page. Enough to scan on a laptop, few enough that the page is not a scroll. */
export const MANAGED_PER_PAGE = 25;

/** The longest search a person types. Longer is not a query, it is a paste. */
const QUERY_MAX = 120;

/** Rows one press may change. Beyond this it is a script, not a person. */
export const BULK_MAX = 200;

/** How many rows a delete confirmation shows before it stops listing them. */
export const CONFIRM_PREVIEW = 25;

/** A screen is managed when the package declared any of the affordances. */
export function isManaged(screen: DeclarativeScreen): boolean {
  return screen.actions !== undefined || screen.filter !== undefined || screen.badge !== undefined;
}

/** The declared filter, with the values a `select` field offers. */
export function filterValues(screen: DeclarativeScreen): string[] {
  const column = screen.filter?.column;
  if (column === undefined) return [];
  return screen.fields?.find((f) => f.name === column)?.options ?? [];
}

/** The action a button posts, by its declared name. `delete` is looked up like any other. */
export function actionOf(screen: DeclarativeScreen, name: string): ScreenAction | undefined {
  return (screen.actions ?? []).find((action) => action.name === name);
}

export interface ManagedQuery {
  /** One of `filterValues(screen)`, or null for every row. */
  filter?: string | null;
  /** Free text, matched against the screen's own declared columns. */
  q?: string | null;
  /** 1-based. Clamped, never trusted. */
  page?: number | null;
}

export interface ManagedResult {
  /** The table's primary key column, so a link addresses a row without guessing at `id`. */
  pk: string;
  rows: Record<string, unknown>[];
  /** Rows matching `q`, before the filter. */
  matching: number;
  /** Rows matching `q` and the filter. */
  total: number;
  /** One entry per declared filter value, each counted over `q` and not over the selected value. */
  counts: { value: string; count: number }[];
  /** The filter applied, or null. Echoed so the screen never re-parses its own query string. */
  filter: string | null;
  q: string;
  page: number;
  pages: number;
}

/** `%` and `_` are characters in a message, not wildcards. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The columns a search reads: what the screen lists, plus the preview the package named. */
function searchColumns(screen: DeclarativeScreen, columns: { name: string; type: string }[]): string[] {
  const declared = new Set<string>([...(screen.list ?? []), ...(screen.fields ?? []).map((f) => f.name)]);
  return columns
    .filter((column) => declared.has(column.name) && column.type.toUpperCase() !== 'BLOB')
    .map((column) => column.name);
}

/**
 * Read one page, and the counts beside it.
 *
 * The counts ignore the selected value and respect `q`: a chip reading "new 12" while the search
 * showed three of them would be a number about a different question than the one asked.
 */
export function readManaged(db: Database.Database, screen: DeclarativeScreen, query: ManagedQuery = {}): ManagedResult {
  const info = describeTable(db, screen.table);
  const values = filterValues(screen);
  const column = screen.filter?.column;

  // A value the package did not declare is not a filter — it is a bad URL. Answering "all" would
  // answer a different question than the one the address asked, so it is dropped deliberately.
  const asked = query.filter ?? null;
  const filter = asked !== null && values.includes(asked) ? asked : null;

  const q = (query.q ?? '').trim().slice(0, QUERY_MAX);
  const search = searchColumns(screen, info.columns);
  const searchWhere = q === '' || search.length === 0
    ? ''
    : ` WHERE ${search.map((c) => `ifnull("${c}", '') LIKE ? ESCAPE '\\'`).join(' OR ')}`;
  const searchParams: unknown[] = q === '' || search.length === 0 ? [] : search.map(() => likePattern(q));

  const count = (where: string, params: unknown[]): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM "${info.name}"${where}`).get(...params) as { n: number }).n;

  const matching = count(searchWhere, searchParams);
  // `searchWhere` already begins with WHERE, so the filter is joined with AND — not appended to a
  // bare " AND", which produced `… FROM t AND status = ?` and a 500 behind every filtered search.
  const where =
    filter === null || column === undefined
      ? searchWhere
      : `${searchWhere === '' ? ' WHERE' : `${searchWhere} AND`} "${column}" = ?`;
  const params = filter === null ? searchParams : [...searchParams, filter];
  const total = count(where, params);

  // Newest first when the table says when it happened. The property sheet ordered by primary key,
  // which is arrival order — the order nobody reads a backlog in.
  const order = info.columns.some((c) => c.name === 'created_at')
    ? `"created_at" DESC, "${info.pk}" DESC`
    : `"${info.pk}" DESC`;

  const pages = Math.max(1, Math.ceil(total / MANAGED_PER_PAGE));
  const rawPage = typeof query.page === 'number' && Number.isFinite(query.page) ? Math.trunc(query.page) : 1;
  const page = Math.min(Math.max(1, rawPage), pages);

  const rows = db
    .prepare(
      `SELECT * FROM "${info.name}"${where} ORDER BY ${order} LIMIT ${MANAGED_PER_PAGE} OFFSET ${(page - 1) * MANAGED_PER_PAGE}`,
    )
    .all(...params) as Record<string, unknown>[];

  const counts =
    column === undefined
      ? []
      : values.map((value) => ({
          value,
          count: count(`${searchWhere === '' ? ' WHERE' : `${searchWhere} AND`} "${column}" = ?`, [
            ...searchParams,
            value,
          ]),
        }));

  return { pk: info.pk, rows, matching, total, counts, filter, q, page, pages };
}

/**
 * The number an app-bar pill shows: rows where the declared column holds the declared value.
 *
 * Null means "draw no pill" — the package is not installed, or its table is gone mid-flight. A
 * badge is never worth a 500 on a page that has nothing to do with it.
 */
export function countBadge(db: Database.Database, screen: DeclarativeScreen): number | null {
  const badge = screen.badge;
  if (badge === undefined) return null;
  try {
    const info = describeTable(db, screen.table);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM "${info.name}" WHERE "${badge.column}" = ?`)
      .get(badge.value) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return null;
  }
}
