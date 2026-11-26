/**
 * **The two robots claims the CMS makes about its own surfaces, in one place.**
 *
 * There are two different sentences here and they must not be confused:
 *
 *   admin          `X-Robots-Tag: noindex, nofollow` + `<meta name="robots" content="noindex,
 *                  nofollow">` — the operator's desk is not content. Nothing under `/admin` or
 *                  `/fleet` may be indexed, ever, and no crawler should follow anything out of it.
 *
 *   a hidden page  `X-Robots-Tag: noindex` + `<meta name="robots" content="noindex">` — a normal
 *                  document an operator chose not to have listed. `follow` is deliberately left
 *                  on: hiding a page from the index is not a claim that its links are bad, and a
 *                  crawler that stops following here would stop finding pages that may be indexed.
 *
 * They live in a leaf module because three callers need the same bytes and two of them cannot
 * import each other: `app/main.ts` (the central `onRequest` hook and the render path) and
 * `app/admin/ui/layout.ts` (the `<meta>` in every admin document). A constant duplicated in two
 * files is a constant that will disagree with itself the first time one of them is edited.
 */

/** The header a crawler reads before it parses a body. Lower case: HTTP/1.1 field names are. */
export const ROBOTS_HEADER = 'x-robots-tag';

/** Every admin response: do not index it, do not follow anything out of it. */
export const ADMIN_ROBOTS_VALUE = 'noindex, nofollow';

/** A page an operator hid from search: do not index it, but its links are still links. */
export const PAGE_ROBOTS_VALUE = 'noindex';

/** The document's own copy of the admin claim, in the head of every admin screen. */
export const ADMIN_ROBOTS_META = '<meta name="robots" content="noindex, nofollow">';

/**
 * The job board's account surface — `/portal/**` — is an auth surface, and an
 * auth surface is not content.
 *
 * Measured, not assumed: `https://fractionalworks.com.au/portal/register?role=advertiser`
 * answered 200 with `<title>Create an account</title>`, `cache-control: no-store`
 * and **no** `X-Robots-Tag`, no `<meta name="robots">` and no canonical. Google
 * crawled both role variants on 22–23 Nov 2026 and filed them under "Duplicate
 * without user-selected canonical" — one step away from being the page a
 * stranger finds when they search the brand. The owner's rule is that no page
 * behind auth may ever be indexed, so the prefix joins `/admin` and `/fleet`.
 *
 * `/portal.css` is deliberately NOT a portal path: it is a stylesheet, and a
 * header on a stylesheet is noise. It is not indexable either (a CSS file is
 * never a search result), but the gate must not 404 it.
 */
export function isPortalPath(url: string): boolean {
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  return pathname === '/portal' || pathname.startsWith('/portal/');
}

/**
 * Is this URL under `/admin` or `/fleet`?
 *
 * The query string is stripped first, so `/admin/login?next=/` and `/admin/login` are the same
 * answer, and the comparison is on whole segments: `/administrator` is not `/admin`, and neither
 * is `/fleetwood`. This is the predicate the header hook in `app/main.ts` uses for **every**
 * method and content type, which is what makes a new admin route non-indexable without the route
 * doing anything.
 */
export function isAdminPath(url: string): boolean {
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  return pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/fleet' || pathname.startsWith('/fleet/');
}
