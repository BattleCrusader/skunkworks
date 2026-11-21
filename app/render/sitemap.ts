/**
 * **The sitemap's URL set, computed in one place.**
 *
 * `/sitemap.xml` was the only reader of this enumeration until IndexNow arrived: a page that
 * becomes public must be *announced*, and a page that stops being public must be announced as
 * gone. Two enumerations would be two answers to "what does this site publish", and the failure
 * they invite is specific and silent — a submission for a draft, a scheduled page or an admin
 * path that the sitemap never listed, and a search engine that learns to distrust the site's
 * signals.
 *
 * So `collectSitemapEntries()` is the set, and `GET /sitemap.xml` and every submission call it.
 * The predicate for a `cms_page` row is `PAGE_VISIBLE` (`app/render/visibility.ts`) plus "not
 * `noindex`" — the same two conditions the route used when the loop lived inside it. A page the
 * operator hid from search is still served, but it is not in `<loc>` and it is not submitted:
 * asking not to be indexed and asking to be crawled in the same breath is a contradiction.
 */
import type Database from 'better-sqlite3';

import type { SitemapEntry } from './delivery.ts';
import { PAGE_VISIBLE, pageIsDue, visibleBefore } from './visibility.ts';
import { pageRobots } from './seo.ts';
import { CORE_PUBLIC_ROUTES, coreSitemapPaths } from './public-routes.ts';

/**
 * The `cms_page` half of the sitemap, as SQL. Exported so a caller that has one path in hand
 * (`listedPagePath()`) reads the same WHERE clause instead of restating it.
 */
export const SITEMAP_PAGE_SQL = `SELECT path, updated_at, seo_json FROM cms_page WHERE ${PAGE_VISIBLE} ORDER BY path`;

/** A package's declared detail page, as much of it as enumeration needs (S8k). */
export interface DeclaredPageLike {
  pattern: string;
  table: string;
  slugColumn: string;
  filter?: { column: string; equals: string };
}

/**
 * The plugin surface enumeration needs — `PluginRuntime` satisfies this structurally, and so can
 * a CLI's runtime, without this module importing the plugin system (which would let a render
 * concern depend on an activation concern).
 */
export interface SitemapPluginSource {
  enter(tenant: string): void;
  leave(tenant: string): void;
  sync(tenant: string): Promise<void>;
  registry: { plugins(tenant: string): Iterable<{ pages: { values(): Iterable<DeclaredPageLike> } }> };
}

export interface SitemapDeps {
  db: Database.Database;
  /** The tenant row's key, for `coreSitemapPaths()`'s own tenant-scoped reads. */
  tenantKey: string;
  /** `https://host` — a `<loc>` is absolute and a crawler has no `Host` to resolve against. */
  origin: string;
  emailMode: 'off' | 'smtp';
  /** Absent (or null) when the caller has no plugin model in this process: core routes only. */
  plugins?: SitemapPluginSource | null;
  now?: Date;
}

/** Every URL the sitemap lists for one tenant, in the order the file lists them. */
export async function collectSitemapEntries(deps: SitemapDeps): Promise<SitemapEntry[]> {
  const { db, tenantKey, origin, emailMode, plugins = null } = deps;
  const now = deps.now ?? new Date();
  const entries: SitemapEntry[] = [];

  const pages = db.prepare(SITEMAP_PAGE_SQL).all(visibleBefore(now)) as {
    path: string;
    updated_at: string;
    seo_json: string | null;
  }[];
  for (const page of pages) {
    // A page the operator hid from search is offered to nobody. It is still served — see
    // `renderPage`, where the row is rendered exactly as before with a `noindex` head — but
    // `<loc>` is an explicit invitation to crawl it, and the sitemap is the one place where
    // asking not to be indexed and asking to be crawled would be a contradiction in the file.
    if (pageRobots(page.seo_json) === 'noindex') continue;
    entries.push({ loc: `${origin}${page.path}`, lastmod: page.updated_at });
  }

  // The board's list and each published advert are core routes rather than `cms_page` rows, so
  // they are enumerated from the one declaration of such routes (`app/render/public-routes.ts`)
  // — the same read `GET /jobs` renders from. An advert is only crawlable if the index that
  // links it is in the file too, so the index comes first and its details follow.
  for (const path of coreSitemapPaths(db, tenantKey, emailMode)) {
    entries.push({ loc: `${origin}${path}` });
  }

  // A package's detail pages are rows, not `cms_page` rows, so they are enumerated through the
  // package's own declaration: a new package joins the sitemap by declaring a page.
  //
  // **Except inside a core route's URL space.** A core route owns its subtree: `/jobs` is drawn
  // by the host, and `/jobs/<id>` is the address it declares canonical, while the job-board
  // package also declares `/jobs/{slug}` for the same advert. Both answer 200, but a sitemap
  // that lists both advertises a duplicate of every row, and advertises a URL whose own
  // `<link rel="canonical">` points elsewhere — a contradiction inside one file. So the
  // declaration that owns the subtree is the one that enumerates it.
  if (plugins !== null) {
    const corePrefixes = CORE_PUBLIC_ROUTES.filter((route) => route.sitemap).map((route) => route.path);
    plugins.enter(tenantKey);
    try {
      await plugins.sync(tenantKey);
      for (const entry of plugins.registry.plugins(tenantKey)) {
        for (const declared of entry.pages.values()) {
          if (corePrefixes.some((path) => declared.pattern === path || declared.pattern.startsWith(`${path}/`))) {
            continue;
          }
          // Only a page whose pattern can be satisfied by a single column is enumerable, and
          // every declared page is exactly that by construction (`/blog/{slug}`).
          const where = declared.filter === undefined ? '' : ` WHERE ${declared.filter.column} = ?`;
          const rows = db
            .prepare(
              `SELECT ${declared.slugColumn} AS slug FROM ${declared.table}${where} ORDER BY ${declared.slugColumn} LIMIT 500`,
            )
            .all(...(declared.filter === undefined ? [] : [declared.filter.equals])) as { slug: string }[];
          for (const row of rows) {
            const path = declared.pattern.replace(/\{[a-z][a-z0-9_]*\}/, encodeURIComponent(row.slug));
            entries.push({ loc: `${origin}${path}` });
          }
        }
      }
    } finally {
      plugins.leave(tenantKey);
    }
  }

  return entries;
}

/**
 * Would the sitemap list this `cms_page` row right now?
 *
 * The per-publish question ("is the page I just acted on public?") is this one, asked of one row.
 * It is `pageIsDue()` — the row form of `PAGE_VISIBLE`, which `visibility.ts` keeps beside the SQL
 * so the two cannot disagree — plus "not `noindex`", which is the second condition the enumeration
 * applies. A row and a path therefore get the same answer.
 *
 * **Deliberately not used to decide removals.** A page that was just deleted or hidden is, by
 * definition, no longer listed — and telling the crawler it is gone is the whole point of the
 * removal signal. Callers compare *was listed* with *is listed*; this function answers only the
 * second half.
 */
export function pageRowListed(
  row: { status: string; published_at: string | null; seo_json: string | null },
  now: Date = new Date(),
): boolean {
  return pageIsDue(row, now) && pageRobots(row.seo_json) !== 'noindex';
}

/** The same question for a path, read from the row. `false` when there is no such row. */
export function listedPagePath(db: Database.Database, path: string, now: Date = new Date()): boolean {
  const row = db
    .prepare('SELECT status, published_at, seo_json FROM cms_page WHERE path = ?')
    .get(path) as { status: string; published_at: string | null; seo_json: string | null } | undefined;
  return row !== undefined && pageRowListed(row, now);
}
