/**
 * **Paths the server answers itself.**
 *
 * A menu entry may point at a `cms_page` row, a page a package declares, or one of these. Without
 * the third case a site cannot link to its own search box: the nav resolver refuses a target with
 * no published page (`SKW_E_RT_NAV_TARGET_MISSING`), which is the right refusal — a menu full of
 * 404s is worse than a short menu — but `/search` is a route, not a page, so it needed a way to be
 * declared.
 *
 * A path belongs here only when the server registers the route unconditionally. A package's pages
 * are not here: they arrive and leave with the package, and `pageExists` (nav.ts) is what tells the
 * resolver about those.
 */

/**
 * Core routes a menu may link to.
 *
 * `/search` only, deliberately. `/jobs` is a core route too, but a job board's own menu entry is
 * resolved through the package's declared pages (`pageExists`), and P-7 pins that the portal and
 * the CMS agree about which of those resolve — a static allowance here would make the two answers
 * diverge again, which is the defect that test exists to catch.
 */
export const CORE_ROUTES: ReadonlySet<string> = new Set(['/search']);

export function isCoreRoute(path: string): boolean {
  return CORE_ROUTES.has(path);
}
