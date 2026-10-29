/**
 * jobboard — the adverts, the companies, the applications.
 *
 * The package is declarative, like everything the host draws: three owned tables, two admin screens,
 * one public page and one public JSON endpoint. It renders no HTML of its own, which is why an
 * advertiser's role description cannot inject anything into the tenant's origin — the host escapes
 * what it draws, and the endpoint returns JSON by contract.
 *
 * What this package deliberately does **not** do:
 *
 *   - **it never sees an identity.** Applications arrive from the portal (`app/accounts/routes.ts`),
 *     which is core because a plugin's `EndpointRequest` carries no actor. This file can read
 *     `p_jobboard_application.account_id`, and nothing here can mint or verify a session.
 *   - **it never decides who may see a profile.** An advertiser reads an applicant's profile through
 *     `app/accounts/policy.ts`, which returns a projection with no contact fields at all. A job
 *     board that let a package render a profile would leak an address the first time somebody added
 *     a column.
 *   - **it does not email.** Publishing a role enqueues rows in `cms_mail` from the portal, where the
 *     notification rule lives with the profile-visibility rule it depends on.
 *
 * The public list is the only unauthenticated read, and it shows published rows only. A draft or a
 * closed advert is invisible to it even if a caller guesses the slug, because the filter is in the
 * query rather than in the page that happens to call it.
 */

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const MAX_OFFSET = 10_000;

/** Trim a value to a string; anything else is empty, never `[object Object]`. */
function text(value, limit = 4000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function activate(ctx) {
  // The board's own screens. `/jobs` is the list an operator publishes from; applications are
  // read-only in the admin because replying to a person happens through the portal, where the
  // address lives and the audit row is written.
  ctx.screen({ path: '/jobs', table: 'p_jobboard_job', title: 'Job adverts' });
  ctx.screen({ path: '/companies', table: 'p_jobboard_company', title: 'Companies' });
  ctx.screen({ path: '/applications', table: 'p_jobboard_application', title: 'Applications' });

  // The public board, on a page the host renders from this table. `/{slug}` is the advert's URL.
  ctx.page({
    pattern: '/jobs/{slug}',
    table: 'p_jobboard_job',
    slug_column: 'slug',
    title_column: 'title',
    body_column: 'body',
    filter: { column: 'status', equals: 'published' },
  });

  // A "latest roles" block for the home page. Published only, newest first.
  ctx.block({
    name: 'latest-jobs',
    label: 'Job board: latest roles',
    table: 'p_jobboard_job',
    columns: ['title', 'location', 'hourly_rate_cents', 'slug'],
    labelColumn: 'title',
    limit: 8,
    orderBy: 'published_at',
    filter: { column: 'status', equals: 'published' },
    layout: 'list',
    href: '/jobs/{slug}',
  });

  ctx.endpoint('GET', 'jobs', async (args) => {
    const query = args.query ?? {};
    const pageSize = await settingInt(args.facade, 'page_size', DEFAULT_PAGE_SIZE);
    const limit = clampInt(query.limit, pageSize, 1, MAX_PAGE_SIZE);
    const offset = clampInt(query.offset, 0, 0, MAX_OFFSET);
    const slug = text(query.slug, 120);

    // `status`, `slug` and `published_at` are the indexed columns the manifest declares, and the
    // host refuses a filter or an order on anything else (SKW_E_PL_QUERY) — a public endpoint must
    // not be able to make the database sort a column nobody indexed.
    const where = [{ column: 'status', op: '=', value: 'published' }];
    if (slug !== '') where.push({ column: 'slug', op: '=', value: slug });

    const page = await args.facade['store.read']('p_jobboard_job', {
      where,
      order: { column: 'published_at', dir: 'desc' },
      limit,
      offset,
    });
    const rows = Array.isArray(page?.rows) ? page.rows : [];

    return {
      count: rows.length,
      jobs: rows.map((row) => ({
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        company: row.company_id,
        hourlyRateCents: row.hourly_rate_cents,
        currency: row.currency,
        daysPerWeek: row.days_per_week,
        location: row.location,
        // v10: the arrangement is a three-word vocabulary on the advert as well as the profile.
        // The column is the manifest's (no CHECK is expressible in the grammar, so the default and
        // the select's options are the control); a row holding anything else reads as 'onsite',
        // which is what the column defaults to.
        workMode: row.work_mode === 'hybrid' || row.work_mode === 'remote' ? row.work_mode : 'onsite',
        publishedAt: row.published_at,
      })),
    };
  });
}

/** The `page_size` setting, floored and capped; an unset or nonsense value falls back. */
async function settingInt(facade, key, fallback) {
  try {
    const value = await facade['settings.get'](key);
    return clampInt(value, fallback, 1, MAX_PAGE_SIZE);
  } catch {
    return fallback;
  }
}
