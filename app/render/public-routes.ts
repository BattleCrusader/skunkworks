/**
 * **The core public routes** — the crawlable pages this box serves that have *no* `cms_page` row.
 *
 * ## Why this file exists
 *
 * `/jobs` is a page an operator cannot see in the page list, because it is not content: the host
 * draws it, and its rows are `p_jobboard_job` adverts published through the portal. The sitemap
 * used to name it with a hardcoded `entries.push({ loc: origin + JOBS_PATH })` inside the route
 * handler, which meant two things could quietly go wrong and neither would fail a build:
 *
 *   1. the *detail* URLs (`/jobs/<id>`) — rows that exist only because the host serves them — were
 *      never listed at all, so every advert a customer paid to publish was invisible to a crawler;
 *   2. a second core route (or a removed one) had to be remembered in the sitemap by hand. The
 *      sitemap and the router could disagree, and the disagreement is invisible in the product:
 *      a `<loc>` that 404s, or a live page nobody is invited to.
 *
 * So the declaration lives here, once, and the sitemap reads it (`coreSitemapPaths`). Adding a
 * host-served page means adding one entry; `buildApp` asserts at boot that every declared path is
 * actually registered as a `GET` route, so the sitemap cannot name a page this box does not serve.
 *
 * ## What belongs here, and what does not
 *
 * A route belongs here when **it is a page a visitor reads and a crawler may index, and it has no
 * `cms_page` row**. Nothing else does:
 *
 *   - `/portal/**` — behind a login, no indexable surface;
 *   - `/search` — a derivative of the site's own pages, `noindex` by policy (`app/render/search.ts`);
 *   - `/admin`, `/fleet` — operator surfaces, `Disallow`ed and header-`noindex`;
 *   - a package's declared detail page (`/blog/{slug}`) — already enumerated from the package's own
 *     declaration in `app/main.ts`, because only the package knows its table.
 *
 * `sitemap: false` exists for a future route that must answer 200 for a person but must not be
 * invited to a crawler; it is not a way to hide a page the product actually publishes.
 */
import type Database from 'better-sqlite3';

import { advertReader } from '../accounts/jobs.ts';
import { JOBS_MAX_PAGE, JOBS_PAGE_SIZE, JOBS_PATH } from './public-jobs.ts';

/** The one `emailMode` union the advert reader accepts, spelled once. */
type EmailMode = 'off' | 'smtp';

/** A host-served public page, and the row-backed URLs that exist beneath it right now. */
export interface CorePublicRoute {
  /** The index URL. Spelled here and nowhere else. */
  readonly path: string;
  /** Whether a crawler is invited to this page and its details. */
  readonly sitemap: boolean;
  /**
   * Whether this tenant has the feature at all. A core route is not a page every site gets: `/jobs`
   * is the job board, and a site without the board has no board — the address must be the site's
   * 404 and must not appear in the sitemap. The router and the sitemap call this same predicate, so
   * "is there a page here" cannot be answered two ways.
   */
  enabled(db: Database.Database, tenant: string, emailMode: EmailMode): boolean;
  /**
   * Every URL below `path` that exists **now**, read from the same facade the page renders from —
   * so a draft, a closed advert, or a tenant without the package contributes nothing, and a
   * deleted one leaves no stale `<loc>` behind.
   */
  details(db: Database.Database, tenant: string, emailMode: EmailMode): readonly string[];
}

/**
 * Whether this tenant's job board is a thing that exists.
 *
 * The answer is the facade's: `advertReader(...).listPublished()` returns `null` when the
 * `jobboard` package is not installed on this tenant, or is installed and disabled. A board that
 * exists but holds no adverts answers with a list of zero rows — that is an empty board, and it is
 * the difference between "we have no roles open" (a page) and "this site has no job board" (a 404).
 */
export function jobsBoardEnabled(db: Database.Database, tenant: string, emailMode: EmailMode): boolean {
  return advertReader(db, tenant, emailMode).listPublished({ limit: 1, offset: 0 }) !== null;
}

/**
 * The job board: `/jobs` plus one URL per published advert.
 *
 * The read is `advertReader(...).listPublished`, the exact call `GET /jobs` renders from, and it is
 * published-only and tenant-scoped by the facade — the sitemap therefore cannot invite a crawler to
 * an advert the board itself refuses. Paging walks the same page size the board uses and stops at
 * the same ceiling `GET /jobs?page=` will answer, so the enumeration is bounded by the product's own
 * limits rather than by a second, private constant.
 */
const jobsRoute: CorePublicRoute = {
  path: JOBS_PATH,
  sitemap: true,
  enabled: jobsBoardEnabled,
  details(db, tenant, emailMode) {
    const reader = advertReader(db, tenant, emailMode);
    const ceiling = JOBS_PAGE_SIZE * JOBS_MAX_PAGE;
    const paths: string[] = [];
    for (let offset = 0; offset < ceiling; offset += JOBS_PAGE_SIZE) {
      const page = reader.listPublished({ limit: JOBS_PAGE_SIZE, offset });
      // `null` is "this box cannot answer" (no package installed, table missing) — an empty board,
      // not an error, and the same answer `GET /jobs` gives.
      if (page === null) break;
      for (const row of page.rows) paths.push(`${JOBS_PATH}/${String(row.id)}`);
      const enumerable = Math.min(page.total, ceiling);
      if (offset + JOBS_PAGE_SIZE >= enumerable) break;
    }
    return paths;
  },
};

/** Every host-served public route. The router and the sitemap both read this. */
export const CORE_PUBLIC_ROUTES: readonly CorePublicRoute[] = [jobsRoute];

/**
 * The sitemap's paths from the core routes: for each route this tenant actually has, the index
 * once, then its details in the order the route enumerated them (newest advert first). A route the
 * tenant does not have contributes nothing — a site without a job board must not advertise one.
 * Duplicates are impossible by construction — the `details` of each route are rows under that
 * route's own path — and are removed anyway so a package quirk cannot publish the same `<loc>`
 * twice.
 */
export function coreSitemapPaths(
  db: Database.Database,
  tenant: string,
  emailMode: EmailMode,
): readonly string[] {
  const seen = new Set<string>();
  for (const route of CORE_PUBLIC_ROUTES) {
    if (!route.sitemap) continue;
    if (!route.enabled(db, tenant, emailMode)) continue;
    seen.add(route.path);
    for (const detail of route.details(db, tenant, emailMode)) seen.add(detail);
  }
  return [...seen];
}
