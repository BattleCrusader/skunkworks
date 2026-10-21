/**
 * blog — one owned table, one declarative screen, one public JSON endpoint.
 *
 * The package's whole surface is the three things the host can name from `plugin.json`:
 *
 *   - the table `p_blog_post`, created by the host from the manifest (never by this file);
 *   - the screen `/blog`, a declarative list/form over that table. A screen is *declared*, not
 *     rendered: the host draws it and the package supplies no markup, which is why nothing here
 *     returns HTML;
 *   - `GET /_plugin/blog/posts`, the only public URL. The host owns the path, resolves the
 *     tenant from the Host header (§5.3), and calls `handler({query, body, method, facade, ctx})`.
 *     The answer is JSON by contract: a package returning HTML would be third-party markup on
 *     the tenant's own origin.
 *
 * It declares no hooks on purpose. The admin menu is derived by the host from the screens a
 * package registers, so `admin.menu` would be a filter that exists to agree with the registry.
 *
 * Everything the package reads goes through the per-request facade, whose first act is to
 * compare the method against the capabilities in the tenant's own installed row. `store.read`
 * needs `store.query`; `settings.get` needs `settings.get`. Nothing here names a tenant — the
 * facade has no tenant parameter and refuses one.
 */

/** Used when the `page_size` setting is unset or is not an integer in range. */
const DEFAULT_PAGE_SIZE = 10;
/** The facade's own ceiling for `store.read` is 500; a public feed has no business near it. */
const MAX_PAGE_SIZE = 50;
const MAX_OFFSET = 10_000;
/** A list item carries an excerpt, not the article: a feed is not a bulk export. */
const EXCERPT_CHARS = 240;

export function activate(ctx) {
  ctx.screen({ path: '/blog', table: 'p_blog_post', title: 'Blog posts' });

  // S8h: the page builder's palette, as a view over this package's own table. The host draws it,
  // so nothing here is markup — only which rows, in which order, with which link.
  ctx.block({
    name: 'recent-posts',
    label: 'Blog: recent posts',
    table: 'p_blog_post',
    columns: ['title', 'published_at', 'slug'],
    labelColumn: 'title',
    limit: 5,
    orderBy: 'published_at',
    filter: { column: 'status', equals: 'published' },
    layout: 'list',
    // A post page is an ordinary page at this path; the block links to it when one exists.
    href: '/blog/{slug}',
  });

  ctx.endpoint('GET', 'posts', async (args) => {
    const query = args.query ?? {};
    const limit = await pageSize(args.facade, query.limit);
    const offset = clampInt(query.offset, 0, 0, MAX_OFFSET);
    const slug = typeof query.slug === 'string' ? query.slug.trim() : '';

    // Only indexed columns may be named in `where`/`order` — the host refuses anything else
    // with SKW_E_PL_QUERY. `status`, `slug` and `published_at` are declared `indexed` in
    // plugin.json for exactly this query.
    const where = [{ column: 'status', op: '=', value: 'published' }];
    if (slug !== '') where.push({ column: 'slug', op: '=', value: slug });

    const page = await args.facade['store.read']('p_blog_post', {
      where,
      order: { column: 'published_at', dir: 'desc' },
      limit,
      offset,
    });
    const rows = Array.isArray(page?.rows) ? page.rows : [];

    return {
      posts: rows.map((row) => publicPost(row, slug !== '')),
      count: rows.length,
      limit,
      offset,
    };
  });
}

/**
 * The wire shape of one post. Deliberately narrow: no `id`, no `status`, no `created_at` — a
 * public feed publishes what a reader needs and nothing an editor works with. `body` is only
 * included when the caller asked for one slug by name, so a list cannot be used to scrape every
 * article in one request.
 */
function publicPost(row, withBody) {
  const post = {
    slug: String(row.slug ?? ''),
    title: String(row.title ?? ''),
    excerpt: excerpt(row.body),
    published_at: row.published_at === null || row.published_at === undefined ? null : String(row.published_at),
  };
  if (withBody) post.body = String(row.body ?? '');
  return post;
}

/** Plain text, tags stripped, whitespace collapsed: an excerpt is read, not rendered. */
function excerpt(body) {
  const text = String(body ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= EXCERPT_CHARS ? text : text.slice(0, EXCERPT_CHARS);
}

/**
 * `?limit=` wins over the package setting, and both are clamped rather than refused: a public
 * feed should answer a bad query with the default page, not with an error a scanner can use to
 * probe the package. The setting is read on every request (it is one indexed row) so an operator
 * who changes it does not have to disable and re-enable the package.
 */
async function pageSize(facade, rawLimit) {
  const requested = Number(rawLimit);
  if (Number.isInteger(requested) && requested >= 1) return Math.min(requested, MAX_PAGE_SIZE);
  const setting = Number(await facade['settings.get']('page_size'));
  if (Number.isInteger(setting) && setting >= 1) return Math.min(setting, MAX_PAGE_SIZE);
  return DEFAULT_PAGE_SIZE;
}

function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export default activate;
