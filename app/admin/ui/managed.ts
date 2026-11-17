/**
 * A managed screen: rows you can narrow, tick and act on in batches.
 *
 * Server-rendered, no client JavaScript — the admin surface is JS-free by design, and a checkbox
 * plus a submit button needs none. That also means the bulk bar is not a floating toolbar that
 * appears when you tick something: it is a row of real submit buttons, and a press with nothing
 * ticked is answered with a sentence rather than ignored. Without JS you cannot grey a button out
 * honestly anyway.
 *
 * **Delete is two steps.** `POST …/bulk` with `action=delete` renders `confirmDeleteScreen` and
 * writes nothing; the second post carries `confirm=1`. An `onclick="return confirm(…)"` would be
 * an inline handler, which this document's CSP refuses — and a one-step delete of twenty enquiries
 * is not a thing to put behind a single mis-click.
 *
 * The words are the operator's, not the schema's: "Received", "Reply to", "Handling". The package
 * supplies the labels through its field declarations, and this file uses them.
 */
import type { DeclarativeScreen } from '../../plugins/registry.ts';
import { whenLabel, esc, plural } from './html.ts';
import { layout, type NavItem } from './layout.ts';
import { MANAGED_PER_PAGE, type ManagedResult } from '../managed.ts';

export interface ManagedScreenInput {
  tenant: { key: string; label: string };
  user: { email: string; role: string } | null;
  screen: DeclarativeScreen;
  result: ManagedResult;
  /** Where this screen lives, e.g. `/admin/t/<key>/<screen path>`. */
  basePath: string;
  csrf: string;
  nav?: NavItem[];
  notices?: number;
  /** The app-bar badge this screen declares; undefined draws none. */
  badge?: { label: string; count: number; href: string };
  flash?: { kind: 'ok' | 'bad'; text: string } | null;
  nowMs: number;
}

/** One line that reads like prose, not like a cell. */
function snippet(value: unknown, max = 170): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A query string that keeps the filter and the search when a link changes one of them.
 *
 * The filter's key is the package's own column name, so the address says what it filters:
 * `?status=new` for a package that declared `status`, `?handling=queued` for one that did not.
 * The base has no favourite parameter name.
 */
function href(basePath: string, key: string, state: { status?: string | null; q?: string; page?: number }): string {
  const params = new URLSearchParams();
  if (state.status !== undefined && state.status !== null && state.status !== '') params.set(key, state.status);
  if (state.q !== undefined && state.q !== '') params.set('q', state.q);
  if (state.page !== undefined && state.page > 1) params.set('page', String(state.page));
  const qs = params.toString();
  return qs === '' ? basePath : `${basePath}?${qs}`;
}

const STYLE = `    <style>
      .msg-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; }
      .msg-chip { display: inline-flex; align-items: baseline; gap: 7px; padding: 7px 12px; border: 1px solid var(--line, #e6e3dc);
        border-radius: 999px; background: var(--card, #fff); font-size: 13px; color: var(--ink-2, #3b3833); text-decoration: none; }
      .msg-chip:hover { border-color: var(--line-2, #d3cec4); text-decoration: none; }
      .msg-chip[aria-current="true"] { background: var(--blue-soft, #eaf0fb); border-color: var(--blue, #3b82f6); color: var(--blue-2, #1d4ed8); font-weight: 600; }
      .msg-chip b { font-variant-numeric: tabular-nums; }
      .msg-chip--new b { color: var(--blue-2, #1d4ed8); }
      .msg-search { display: flex; gap: 8px; margin: 0 0 14px; flex-wrap: wrap; }
      .msg-search input[type="search"] { flex: 1 1 260px; min-height: 38px; padding: 0 12px; border: 1px solid var(--line-2, #d3cec4);
        border-radius: var(--r-in, 10px); font: 13.5px/1.3 var(--sans, system-ui); background: #fff; color: var(--ink, #23211d); }
      .msg-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
      .msg-table th, .msg-table td { text-align: left; padding: 11px 10px; border-bottom: 1px solid var(--line, #e6e3dc); vertical-align: top; }
      .msg-table thead th { font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted, #7a756c); font-weight: 600; white-space: nowrap; }
      .msg-table tbody tr:hover { background: var(--card-2, #f7f6f2); }
      .msg-table .msg-pick { width: 34px; }
      /* An address is one token: wrapping it mid-word makes two rows out of one and reads as two people. */
      .msg-table td:has(.msg-mail) { white-space: nowrap; }
      .msg-table .msg-pick input { width: 16px; height: 16px; }
      .msg-who { font-weight: 600; color: var(--ink, #23211d); text-decoration: none; }
      .msg-who:hover { text-decoration: underline; }
      .msg-co { display: block; font-size: 12px; color: var(--muted, #7a756c); }
      .msg-mail { color: var(--blue-2, #1d4ed8); text-decoration: none; white-space: nowrap; }
      .msg-mail:hover { text-decoration: underline; }
      .msg-body { color: var(--ink-2, #3b3833); max-width: 46ch; }
      .msg-when { white-space: nowrap; color: var(--muted, #7a756c); font-size: 12.5px; }
      .msg-badge { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
        letter-spacing: .02em; background: var(--card-2, #f0eee8); color: var(--muted, #7a756c); white-space: nowrap; }
      .msg-badge--new { background: var(--blue-soft, #eaf0fb); color: var(--blue-2, #1d4ed8); }
      .msg-badge--replied { background: #e8f3ec; color: #256b45; }
      .msg-badge--archived { background: transparent; color: var(--muted, #7a756c); border: 1px solid var(--line, #e6e3dc); }
      .msg-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 16px 0 0; padding: 12px 0 0;
        border-top: 1px solid var(--line, #e6e3dc); }
      .msg-bar p { margin: 0; font-size: 12.5px; color: var(--muted, #7a756c); }
      .msg-bar button { min-height: 34px; padding: 0 13px; border-radius: var(--r-sm, 8px); border: 1px solid var(--line-2, #d3cec4);
        background: #fff; color: var(--ink-2, #3b3833); font: 600 12.5px/1 var(--sans, system-ui); cursor: pointer; }
      .msg-bar button:hover { border-color: var(--blue, #3b82f6); color: var(--blue-2, #1d4ed8); }
      .msg-bar button[value="delete"] { margin-left: auto; border-color: var(--red-line, #e3b4b4); color: #a02a2a; background: var(--red-soft, #fdf2f2); }
      .msg-pager { display: flex; align-items: center; gap: 12px; margin: 16px 0 0; font-size: 13px; color: var(--muted, #7a756c); }
      .msg-pager a { color: var(--blue-2, #1d4ed8); text-decoration: none; }
      .msg-pager a:hover { text-decoration: underline; }
      .msg-pager .spacer { margin-left: auto; }
      .msg-empty { margin: 0; padding: 24px 0; color: var(--muted, #7a756c); font-size: 14px; }
      .msg-confirm { margin: 0 0 16px; padding: 14px 16px; border: 1px solid var(--red-line, #e3b4b4); border-radius: 10px;
        background: var(--red-soft, #fdf2f2); color: #7d2020; font-size: 13.5px; }
      .msg-confirm p { margin: 0; }
      .msg-confirm p + p { margin-top: 6px; }
      .msg-list { margin: 0 0 18px; padding: 0; list-style: none; }
      .msg-list li { padding: 10px 0; border-bottom: 1px solid var(--line, #e6e3dc); font-size: 13.5px; }
      .msg-list li:last-child { border-bottom: 0; }
    </style>`;

/** The label the package gave a column, its own name if it gave none, or a readable fallback. */
function labelOf(screen: DeclarativeScreen, column: string): string {
  const field = screen.fields?.find((f) => f.name === column);
  if (field?.label !== undefined) return field.label;
  // A timestamp column nobody labelled still needs a header a person can read.
  if (column.endsWith('_at')) return 'When';
  return column.replace(/_/g, ' ');
}

/**
 * One managed screen, drawn from the package's own declarations.
 *
 * This serves every screen whose package declared it managed: the columns come from the screen's
 * `list`, their headers from the field labels, the preview from `screen.preview`, the filter and its
 * chips from `screen.filter`, the buttons from `screen.actions`. Nothing here knows what a record
 * is — which is why the same code serves a blog's posts, and why a package that invents a new
 * inbox-shaped table gets this screen for free.
 */
export function managedScreen(input: ManagedScreenInput): string {
  const { screen, result, basePath, tenant } = input;
  const pk = result.pk;
  const stateColumn = screen.filter?.column;
  const filterKey = stateColumn ?? 'filter';
  const previewColumn = screen.preview;

  const chip = (label: string, count: number, status: string | null, isNew: boolean): string =>
    `<a class="msg-chip${isNew ? ' msg-chip--new' : ''}" href="${esc(href(basePath, filterKey, { status, q: result.q }))}"${
      (status ?? null) === result.filter ? ' aria-current="true"' : ''
    }>${esc(label)} <b>${count}</b></a>`;

  const allCount = result.counts.reduce((sum, c) => sum + c.count, 0);
  const chips = [
    chip('All', allCount, null, false),
    ...result.counts.map((c, i) => chip(c.value, c.count, c.value, i === 0)),
  ].join('\n        ');

  // The columns: the screen's own list, then the one long-text preview if the list does not
  // already carry it. The primary key stays out — it is in the row, not in the table.
  const listColumns = (screen.list ?? []).filter((c) => c !== pk);
  const preview = previewColumn;
  const columns = preview === undefined || listColumns.includes(preview) ? listColumns : [...listColumns, preview];

  const cellOf = (row: Record<string, unknown>, column: string, detail: string): string => {
    const raw = row[column];
    const text = raw === null || raw === undefined ? '' : String(raw);
    if (column === stateColumn) {
      return `<span class="msg-badge${text === '' ? '' : ` msg-badge--${esc(text)}`}">${esc(text === '' ? '—' : text)}</span>`;
    }
    if (column.endsWith('_at') && text !== '') {
      return `<time datetime="${esc(text)}" title="${esc(text)}">${esc(whenLabel(text, input.nowMs))}</time>`;
    }
    if (column === preview) return `<span class="msg-body">${esc(snippet(text))}</span>`;
    if (column === columns[0]) return `<a class="msg-who" href="${esc(detail)}">${esc(text === '' ? `Row ${String(row[pk] ?? '')}` : text)}</a>`;
    if (column === 'email') return `<a class="msg-mail" href="mailto:${esc(text)}">${esc(text)}</a>`;
    return esc(text.length > 60 ? `${text.slice(0, 59)}…` : text);
  };

  const head = columns.map((c) => `<th>${esc(labelOf(screen, c))}</th>`).join('');
  const rows =
    result.rows.length === 0
      ? `<tr><td class="msg-empty" colspan="${columns.length + 2}">${
          result.q !== ''
            ? `Nothing matches “${esc(result.q)}”${result.filter === null ? '' : ` with “${esc(result.filter)}”`}.`
            : result.filter === null
              ? 'Nothing here yet.'
              : `Nothing is marked “${esc(result.filter)}”.`
        }</td></tr>`
      : result.rows
          .map((row) => {
            const id = String(row[pk] ?? '');
            const detail = `${basePath}/${encodeURIComponent(id)}`;
            const cells = columns.map((c) => `<td>${cellOf(row, c, detail)}</td>`).join('');
            return `<tr data-id="${esc(id)}">
            <td class="msg-pick"><input type="checkbox" name="ids" value="${esc(id)}" aria-label="Select ${esc(String(row[columns[0] ?? pk] ?? id))}"></td>
            ${cells}<td><a href="${esc(detail)}">edit</a></td>
          </tr>`;
          })
          .join('\n        ');

  // One button per declared action, in the package's own order and its own words.
  const actions = (screen.actions ?? [])
    .map(
      (action) =>
        `<button type="submit" name="action" value="${esc(action.name)}"${
          action.delete === true ? ' class="msg-danger"' : ''
        }>${esc(action.label)}</button>`,
    )
    .join('\n          ');

  const bar =
    result.rows.length === 0
      ? ''
      : `<div class="msg-bar">
          <p>Tick the rows you want, then choose what to do with them.</p>
          ${actions}
        </div>`;

  const firstRow = result.total === 0 ? 0 : (result.page - 1) * MANAGED_PER_PAGE + 1;
  const lastRow = Math.min(result.page * MANAGED_PER_PAGE, result.total);
  const pager =
    result.pages <= 1
      ? ''
      : `<div class="msg-pager">
          <span>${firstRow}–${lastRow} of ${plural(result.total, 'row')}</span>
          <span class="spacer"></span>
          ${result.page > 1 ? `<a href="${esc(href(basePath, filterKey, { status: result.filter, q: result.q, page: result.page - 1 }))}" rel="prev">← Back</a>` : ''}
          <span>Page ${result.page} of ${result.pages}</span>
          ${result.page < result.pages ? `<a href="${esc(href(basePath, filterKey, { status: result.filter, q: result.q, page: result.page + 1 }))}" rel="next">More →</a>` : ''}
        </div>`;

  const body = `${STYLE}
    <div class="pagehead">
      <div>
        <h1>${esc(screen.title)}</h1>
        <p>${plural(allCount, 'row')}.</p>
      </div>
      ${"" /* A managed screen is a queue you work through, not a table you add rows to: a message
             arrives from a form, not from an operator. The generic browser keeps its New button. */}
    </div>

    <nav class="msg-crumbs" aria-label="Breadcrumb">
      <a href="/admin/t/${esc(tenant.key)}/">Pages</a> / <span aria-current="page">${esc(screen.title)}</span>
    </nav>

    <nav class="msg-chips" aria-label="Filter by ${esc(stateColumn === undefined ? 'state' : labelOf(screen, stateColumn))}">
        ${chips}
    </nav>

    <form class="msg-search" method="get" action="${esc(basePath)}" role="search">
      ${result.filter === null ? '' : `<input type="hidden" name="${esc(filterKey)}" value="${esc(result.filter)}">`}
      <input type="search" name="q" value="${esc(result.q)}" placeholder="Search…" aria-label="Search">
      <button class="btn btn--sm" type="submit">Search</button>
      ${result.q === '' ? '' : `<a class="btn btn--sm" href="${esc(href(basePath, filterKey, { status: result.filter }))}">Clear</a>`}
    </form>

    <div class="card card--padded">
      <form method="post" action="${esc(`${basePath}/bulk`)}">
        <input type="hidden" name="csrf" value="${esc(input.csrf)}">
        ${result.filter === null ? '' : `<input type="hidden" name="${esc(filterKey)}" value="${esc(result.filter)}">`}
        ${result.q === '' ? '' : `<input type="hidden" name="q" value="${esc(result.q)}">`}
        <input type="hidden" name="page" value="${result.page}">
        <table class="msg-table" data-role="rows">
          <thead><tr><th class="msg-pick"><span class="msg-sr">Select</span></th>${head}<th></th></tr></thead>
          <tbody>
        ${rows}
          </tbody>
        </table>
        ${bar}
      </form>
      ${pager}
    </div>`;

  return layout({
    title: `${tenant.key} — ${screen.title}`,
    tenant: { key: tenant.key, label: tenant.label },
    user: input.user,
    active: 'none',
    ...(input.nav === undefined ? {} : { nav: input.nav }),
    ...(input.notices === undefined ? {} : { notices: input.notices }),
    ...(input.badge === undefined ? {} : { badge: input.badge }),
    ...(input.flash === undefined || input.flash === null ? {} : { flash: input.flash }),
    body,
  });
}

export interface ConfirmDeleteInput {
  tenant: { key: string; label: string };
  user: { email: string; role: string } | null;
  screen: DeclarativeScreen;
  basePath: string;
  csrf: string;
  ids: string[];
  /** The table's primary key, so the rows below can name themselves. */
  pk: string;
  /** The rows those ids name, for the operator to recognise before they go. */
  rows: Record<string, unknown>[];
  /** The package's own warning, from the delete action it declared. */
  warning: string;
  /** The delete action's label, for the button. */
  label: string;
  /** The delete action's own name, which the confirming POST must carry. */
  actionName: string;
  /** The package's preview column, if it declared one, for recognising a row. */
  preview?: string;
  /** The screen's first listed column, so a row can always be named. */
  firstColumn: string;
  /** The query key the filter travels under — the package's own column name. */
  filterKey: string;
  /** Filter state to restore if the operator cancels. */
  state: { filter: string | null; q: string; page: number };
  nav?: NavItem[];
  notices?: number;
  badge?: { label: string; count: number; href: string };
  nowMs: number;
}

/**
 * The second half of a delete: what will go, and one button that does it.
 *
 * It is a page rather than a dialog because the document refuses inline handlers, and because a
 * list of what is about to be destroyed is more honest as something you can read than as a line
 * of text in a `confirm()` box.
 */
export function confirmDeleteScreen(input: ConfirmDeleteInput): string {
  const what = plural(input.ids.length, 'row');
  const items = input.rows
    .map(
      (row) => {
        const title = String(row[input.firstColumn] ?? `Row ${String(row[input.pk] ?? '')}`);
        const body = input.preview === undefined ? '' : snippet(row[input.preview], 110);
        return `<li><b>${esc(title)}</b>${body === '' ? '' : ` — ${esc(body)}`}</li>`;
      },
    )
    .join('\n        ');

  const body = `${STYLE}
    <div class="pagehead">
      <div>
        <h1>${esc(input.label)}</h1>
        <p>${esc(input.warning)}</p>
      </div>
    </div>

    <div class="msg-confirm">
      <p><b>${esc(what)} will be deleted.</b></p>
      ${input.rows.length < input.ids.length ? `<p>Showing the first ${input.rows.length} of them.</p>` : ''}
    </div>

    <ul class="msg-list">
        ${items}
    </ul>

    <form method="post" action="${esc(`${input.basePath}/bulk`)}">
      <input type="hidden" name="csrf" value="${esc(input.csrf)}">
      <input type="hidden" name="action" value="delete">
      <input type="hidden" name="confirm" value="1">
      ${input.state.filter === null ? '' : `<input type="hidden" name="${esc(input.filterKey)}" value="${esc(input.state.filter)}">`}
      ${input.state.q === '' ? '' : `<input type="hidden" name="q" value="${esc(input.state.q)}">`}
      <input type="hidden" name="page" value="${input.state.page}">
      ${input.ids.map((id) => `<input type="hidden" name="ids" value="${esc(id)}">`).join('\n      ')}
      <button class="btn" type="submit" name="action" value="${esc(input.actionName)}">${esc(input.label)}</button>
      <a class="btn" href="${esc(href(input.basePath, input.filterKey, input.state))}">Cancel</a>
    </form>`;

  return layout({
    title: `${input.tenant.key} — delete ${what}`,
    tenant: { key: input.tenant.key, label: input.tenant.label },
    user: input.user,
    active: 'none',
    ...(input.nav === undefined ? {} : { nav: input.nav }),
    ...(input.notices === undefined ? {} : { notices: input.notices }),
    ...(input.badge === undefined ? {} : { badge: input.badge }),
    body,
  });
}
