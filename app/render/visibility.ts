/**
 * **When a published page becomes visible** — one predicate, every reader.
 *
 * `cms_page.status = 'published'` used to be the whole answer, and the renderer, the sitemap,
 * the nav resolver and the exporter each spelled that answer themselves. Scheduling makes the
 * question two-part: a page can be published *and not yet due*, because `published_at` is the
 * moment it goes live and an operator may name a moment that has not arrived.
 *
 * The predicate is written once, as SQL, because four readers disagreeing about visibility is the
 * exact bug this file exists to prevent: a page hidden from the renderer but listed in the
 * sitemap is a crawlable 404, and one hidden from the renderer but shipped in an export is a page
 * that exists in the bundle and nowhere on the site.
 *
 *   status = 'published'  AND  (published_at IS NULL OR published_at <= now)
 *
 * `published_at IS NULL` stays visible on purpose: `managed_by = 'hand'` rows and the seeded
 * pages have no publish time, and they have always been served. A schedule can only ever narrow
 * that set, never hide a page that was live before this column meant anything.
 *
 * Timestamps are ISO-8601 UTC (`toISOString()`, and the DDL default is the same shape), so a
 * lexicographic comparison is a chronological one. The publish path normalises through
 * `normaliseInstant()` below rather than trusting a form field, because a value stored with a
 * non-UTC offset would compare wrongly and hide a page that had just gone live.
 */

/** SQL fragment. Binds one parameter: the current instant as an ISO-8601 UTC string. */
export const PAGE_VISIBLE = "status = 'published' AND (published_at IS NULL OR published_at <= ?)";

/** The instant to bind against `PAGE_VISIBLE`. */
export function visibleBefore(now: Date = new Date()): string {
  return now.toISOString();
}

/**
 * The same predicate for a caller that already holds the row (a nav target, an admin row) and
 * cannot put it back in a `WHERE`. Kept beside the SQL so the two can never disagree about what
 * `published_at IS NULL` means.
 */
export function pageIsDue(
  row: { status: string; published_at: string | null },
  now: Date = new Date(),
): boolean {
  if (row.status !== 'published') return false;
  return row.published_at === null || row.published_at <= visibleBefore(now);
}

/**
 * A form value or API field to an instant this schema can compare, or null when it is not a time.
 *
 * `datetime-local` sends `2026-12-01T09:00` (no zone, no seconds), which `new Date()` reads as
 * local time — correct for an operator typing in their own clock, and the only reading that does
 * not require the browser to know the site's zone. Anything unparseable returns null so the
 * caller can refuse it by name instead of storing "Invalid Date".
 */
export function normaliseInstant(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}
