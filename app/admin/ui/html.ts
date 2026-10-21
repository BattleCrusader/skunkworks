/**
 * The three screens this file serves are read by a person, not a program, so the
 * escaping lives in one place and every value that reaches HTML goes through it.
 *
 * `escapeHtml` is the same five replacements `routes.ts` has always done by hand —
 * `&` first, then `<`, `>`, `"`, `'`. Keeping one implementation means a new screen
 * cannot inherit a weaker copy of it.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `esc` is the short name used inside the screen builders; it is the same function. */
export const esc = escapeHtml;

/**
 * Bytes the way the design writes them: 940 B, 1.2 KB, 762 KB, 4.1 MB.
 *
 * One decimal only below 10 units, because "1.2 KB" is a size a person can hold in
 * their head and "1.226 KB" is not.
 */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 10) return `${(Math.round(kb * 10) / 10).toString()} KB`;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 10) return `${(Math.round(mb * 10) / 10).toString()} MB`;
  return `${Math.round(mb)} MB`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "20 October" — the design's date, and the only date this admin shows. */
export function dayAndMonth(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'an unknown date';
  const d = new Date(at);
  const month = MONTHS[d.getUTCMonth()] ?? '';
  return `${d.getUTCDate()} ${month}`;
}

/**
 * "Saved 41 minutes ago" under a day, "Updated 20 October" after it.
 *
 * `nowMs` is passed in rather than read here so the string is a function of its
 * inputs: a test can pin it, and two screens rendered in one request agree.
 */
export function whenLabel(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'at an unknown time';
  const delta = nowMs - at;
  if (delta < 45_000) return 'just now';
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.round(delta / 3_600_000);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(delta / 86_400_000);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return `on ${dayAndMonth(iso)}`;
}

/** "1 page" / "3 pages" — the plural is written, never a bare number beside a noun. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The first letter of a page's title, for the coloured tile in the page list.
 *
 * A tile with no letter would be an empty coloured square, so anything that has no
 * letter or digit falls back to a hash of the path — stable, and never blank.
 */
export function initialOf(title: string, fallback: string): string {
  for (const ch of title) {
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase();
  }
  for (const ch of fallback) {
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase();
  }
  return '#';
}

/**
 * One of three gradients, chosen by a stable hash of the page's path.
 *
 * Colour is decoration here: the letter inside the tile and the word beside it both
 * carry the meaning, so a tenant whose pages all hash to `a` loses nothing.
 */
export function tintOf(seed: string): 'a' | 'b' | 'c' {
  let h = 0;
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 997;
  return (['a', 'b', 'c'] as const)[h % 3] ?? 'a';
}
