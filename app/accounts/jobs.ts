/**
 * The advert, as the portal is allowed to read it — **read-only, through the plugin facade**.
 *
 * The job board package owns `p_jobboard_job` and `p_jobboard_company`, and two readers need
 * facts from them: the portal (is this advert open, and which account owns the company behind it)
 * and the public board (what a published advert says). None of those facts is identity — an
 * advert is public content — but the tables are not core, so nothing here writes SQL against them.
 * Every read goes through `hostOp`, the one layer that knows a plugin's tables and enforces the
 * manifest's declared, indexed columns. That is also why these reads are *genuinely* required
 * rather than a shortcut: there is no core mirror of an advert, and the alternative — a core table
 * shadowing plugin content — would be a second source of truth that can disagree.
 *
 * What this module deliberately cannot do:
 *
 *   - **write.** Only `store.query` and `store.count` are called, so a portal bug cannot edit an
 *     advert.
 *   - **decide anything about a person.** It returns integers and strings from the advert and the
 *     company's name; the decision about what a viewer may see lives in `policy.ts`, which never
 *     sees a plugin row. `PublicAdvert` carries no account id, so a public page cannot leak one.
 *   - **return an unpublished row to a public caller.** `published`/`publishedBySlug`/`listPublished`
 *     put `status = 'published'` in the query rather than in the page that calls them: a draft is
 *     invisible even to a caller that guesses its id.
 *   - **throw at the caller for a missing plugin.** A tenant without the job board installed has no
 *     adverts, which is an empty board and not a 500. Every call answers `null`/empty, and the
 *     callers turn that into a named refusal ("that advert is not on this board") or an empty state.
 */
import type Database from 'better-sqlite3';

import { installedPlugins } from '../plugins/install.ts';
import { hostOp, type HostContext } from '../plugins/ops.ts';

/** The package id the portal reads. One constant, so a rename is one edit and a loud one. */
export const JOBBOARD_PLUGIN = 'jobboard';

/** The two facts the portal needs about one advert. Nothing here is personal data. */
export interface JobFact {
  readonly id: number;
  readonly title: string;
  readonly status: string;
  readonly companyId: number;
}

/**
 * One advert as a visitor may read it: the published row plus the name of the company that posted
 * it. `dayRateCents`/`daysPerWeek` are `null` when the advertiser left them empty ("discussed"),
 * which is a fact about the advert rather than a missing value to invent.
 */
export interface PublicAdvert {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  /** `''` when the company row is gone; the renderer says "company not stated" rather than guess. */
  readonly companyName: string;
  readonly dayRateCents: number | null;
  readonly currency: string;
  readonly daysPerWeek: number | null;
  readonly location: string;
  readonly remoteOk: boolean;
  /** The date the advert went live, `YYYY-MM-DD…`; `null` for a published row never given one. */
  readonly publishedAt: string | null;
}

export interface AdvertList {
  readonly rows: readonly PublicAdvert[];
  /** Every published advert in this tenant, not only the page `listPublished` returned. */
  readonly total: number;
}

export interface AdvertReader {
  /** The advert, or `null` when the plugin is not installed, the row is gone, or the read refused. */
  job(id: number): JobFact | null;
  /** The account that owns a company, or `null` for the same reasons. */
  companyOwner(companyId: number): number | null;
  /** One **published** advert by its own id, or `null` — a draft or closed row is `null`. */
  published(id: number): PublicAdvert | null;
  /**
   * One **published** advert by its slug — the address the home page's "latest roles" block links
   * to. A slug is not a secret: the filter is the status, not the caller.
   */
  publishedBySlug(slug: string): PublicAdvert | null;
  /** A page of published adverts, newest first. `null` when the board is not installed. */
  listPublished(page: { readonly limit: number; readonly offset: number }): AdvertList | null;
}

interface Row {
  readonly [column: string]: unknown;
}

interface QueryArgs {
  readonly where?: readonly unknown[];
  readonly order?: { readonly column: string; readonly dir: 'asc' | 'desc' };
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * A facade call that returns rows, or `null`.
 *
 * `hostOp` raises plain `Error`s carrying the plugin protocol's codes (`SKW_E_PL_*`), which never
 * become an HTTP response of their own. For a reader of reference data, every one of them — no
 * package installed, table not created yet, a column the manifest does not declare — has the same
 * meaning: this box cannot answer, so the caller must not invent an answer. The refusal is logged
 * nowhere and surfaced by the caller as "not on this board", which is true of an empty board.
 */
function query(db: Database.Database, ctx: HostContext | null, table: string, args: QueryArgs): Row[] | null {
  if (ctx === null) return null;
  try {
    const result = hostOp(ctx, 'store.query', { table, ...args }) as { rows?: unknown };
    return Array.isArray(result.rows) ? (result.rows as Row[]) : null;
  } catch {
    return null;
  }
}

/** The published-advert count, or `null` when the board cannot answer. */
function countPublished(db: Database.Database, ctx: HostContext | null): number | null {
  if (ctx === null) return null;
  try {
    const result = hostOp(ctx, 'store.count', {
      table: 'p_jobboard_job',
      where: [{ column: 'status', op: '=', value: 'published' }],
    }) as { count?: unknown };
    return typeof result.count === 'number' ? result.count : null;
  } catch {
    return null;
  }
}

function str(row: Row, column: string): string {
  const value = row[column];
  return typeof value === 'string' ? value : '';
}

function intOrNull(row: Row, column: string): number | null {
  const value = row[column];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** A row → the public shape, or `null` when the row cannot describe an advert. */
function advertOf(row: Row, companyName: string): PublicAdvert | null {
  const id = intOrNull(row, 'id');
  const title = str(row, 'title');
  const companyId = intOrNull(row, 'company_id');
  if (id === null || id <= 0 || title === '' || companyId === null) return null;
  const currency = str(row, 'currency').trim().toUpperCase();
  const publishedAt = str(row, 'published_at');
  return {
    id,
    slug: str(row, 'slug'),
    title,
    summary: str(row, 'summary'),
    body: str(row, 'body'),
    companyName,
    dayRateCents: intOrNull(row, 'day_rate_cents'),
    currency: currency === '' ? 'AUD' : currency,
    daysPerWeek: intOrNull(row, 'days_per_week'),
    location: str(row, 'location').trim(),
    remoteOk: row['remote_ok'] === 1,
    publishedAt: publishedAt === '' ? null : publishedAt,
  };
}

/**
 * A reader bound to one open handle. The installed manifest is read once per reader rather than per
 * call: `store.query` re-validates its grant against the database row on every call by design, and
 * re-parsing the manifest for each of a page's rows would be work with no extra guarantee.
 */
export function advertReader(
  db: Database.Database,
  tenant: string,
  emailMode: 'off' | 'smtp',
): AdvertReader {
  let ctx: HostContext | null | undefined;
  const context = (): HostContext | null => {
    if (ctx !== undefined) return ctx;
    const installed = installedPlugins(db).find((p) => p.plugin_id === JOBBOARD_PLUGIN && p.enabled);
    ctx =
      installed === undefined
        ? null
        : { db, tenant, plugin: JOBBOARD_PLUGIN, manifest: installed.manifest, emailMode };
    return ctx;
  };

  /**
   * The names of the companies behind a set of adverts: one `in` query, not one per row.
   *
   * `company_id` is indexed by the package's own DDL, and `id` is the primary key, so this is the
   * one shape §8.3 allows for a batch read. A company whose row is gone is simply absent from the
   * map; the renderer says so rather than printing a number.
   */
  const companyNames = (ids: readonly number[]): Map<number, string> => {
    const names = new Map<number, string>();
    const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
    if (unique.length === 0) return names;
    const rows =
      query(db, context(), 'p_jobboard_company', {
        where: [{ column: 'id', op: 'in', value: unique }],
        limit: unique.length,
      }) ?? [];
    for (const row of rows) {
      const id = intOrNull(row, 'id');
      const name = str(row, 'name');
      if (id !== null && name !== '') names.set(id, name);
    }
    return names;
  };

  const publishedWhere = (extra: readonly unknown[] = []): readonly unknown[] => [
    { column: 'status', op: '=', value: 'published' },
    ...extra,
  ];

  /** The one query both public readers use; `extraWhere` is already a facade condition. */
  const publishedRows = (extraWhere: readonly unknown[], limit: number, offset: number): Row[] | null =>
    query(db, context(), 'p_jobboard_job', {
      where: publishedWhere(extraWhere),
      order: { column: 'published_at', dir: 'desc' },
      limit,
      offset,
    });

  const one = (extraWhere: readonly unknown[]): PublicAdvert | null => {
    const rows = publishedRows(extraWhere, 1, 0);
    const row = rows?.[0];
    if (row === undefined) return null;
    const companyId = intOrNull(row, 'company_id');
    const name = companyId === null ? '' : (companyNames([companyId]).get(companyId) ?? '');
    return advertOf(row, name);
  };

  return {
    job(id: number): JobFact | null {
      if (!Number.isInteger(id) || id <= 0) return null;
      const rows = query(db, context(), 'p_jobboard_job', {
        where: [{ column: 'id', op: '=', value: id }],
        limit: 1,
      });
      const row = rows?.[0];
      if (row === undefined) return null;
      const title = row.title;
      const status = row.status;
      const companyId = row.company_id;
      if (typeof title !== 'string' || typeof status !== 'string' || typeof companyId !== 'number') return null;
      return { id, title, status, companyId };
    },

    companyOwner(companyId: number): number | null {
      if (!Number.isInteger(companyId) || companyId <= 0) return null;
      const rows = query(db, context(), 'p_jobboard_company', {
        where: [{ column: 'id', op: '=', value: companyId }],
        limit: 1,
      });
      const row = rows?.[0];
      if (row === undefined) return null;
      const accountId = row.account_id;
      return typeof accountId === 'number' && Number.isInteger(accountId) && accountId > 0 ? accountId : null;
    },

    published(id: number): PublicAdvert | null {
      if (!Number.isInteger(id) || id <= 0) return null;
      return one([{ column: 'id', op: '=', value: id }]);
    },

    publishedBySlug(slug: string): PublicAdvert | null {
      const trimmed = slug.trim();
      // `slug` is `TEXT NOT NULL`; an empty one is not an address and would match nothing anyway.
      if (trimmed === '' || trimmed.length > 200) return null;
      return one([{ column: 'slug', op: '=', value: trimmed }]);
    },

    listPublished(page: { readonly limit: number; readonly offset: number }): AdvertList | null {
      const limit = Math.min(100, Math.max(1, Math.trunc(page.limit)));
      const offset = Math.max(0, Math.trunc(page.offset));
      const rows = publishedRows([], limit, offset);
      if (rows === null) return null;
      const total = countPublished(db, context());
      if (total === null) return null;
      const names = companyNames(
        rows.map((row) => intOrNull(row, 'company_id')).filter((id): id is number => id !== null),
      );
      const adverts: PublicAdvert[] = [];
      for (const row of rows) {
        const companyId = intOrNull(row, 'company_id');
        const advert = advertOf(row, companyId === null ? '' : (names.get(companyId) ?? ''));
        // A row the manifest cannot describe is dropped rather than rendered half-empty: the board
        // shows adverts it can state completely, and a broken row is an operator's problem, not a
        // visitor's.
        if (advert !== null) adverts.push(advert);
      }
      return { rows: adverts, total };
    },
  };
}
