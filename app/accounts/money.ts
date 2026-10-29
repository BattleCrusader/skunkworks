/**
 * The rate — dollars as a person types them, cents as the column stores them, `/hour` as they read
 * it. One module, because there are three places a rate is entered or shown (the applicant's
 * profile form, the job board's advert form, the public board) and a second copy of this arithmetic
 * is a second way to be a cent out.
 *
 * ## Why the column is cents and the form is dollars
 *
 * A floating-point dollar is a rounding error waiting for a total: `95.10 * 3` is not 285.30 in
 * IEEE 754. So the database keeps an integer number of cents, and every human-facing string is
 * dollars — the input, the label, the page. The conversion happens exactly once, here, on the way
 * in and on the way out.
 *
 * ## Why the ceiling is a product rule and not a column's opinion
 *
 * `$5,000 an hour` is past any fractional role this board carries; a value above it is a typo
 * (`950000` for `9500`), and storing it would put a nonsense price in front of an advertiser. The
 * column's CHECK enforces the same bound, so a form that forgot to validate is still refused by
 * the file — the validator is the courtesy, the constraint is the control.
 */

/** The most a rate may be, in cents: $5,000.00 an hour. The column's CHECK says the same number. */
export const RATE_MAX_CENTS = 500_000;

export type ParsedRate =
  | { readonly ok: true; readonly cents: number | null }
  | { readonly ok: false; readonly problem: string };

/**
 * `'95'`, `'95.5'`, `'95.50'` → 9500, 9550, 9550. Empty is `null` ("not stated"), which is an
 * answer and not an error.
 *
 * Everything else is a sentence rather than `NaN` on its way into a CHECK: a negative amount, more
 * than two decimal places (a third decimal place is a price the schema cannot hold), a value past
 * the ceiling, or anything that is not a plain decimal (`1e3`, `9,500`, `ninety-five`, `$95`). The
 * parse is deliberately strict — a lenient one accepts `95.505` and rounds somebody's rate.
 */
export function parseRateDollars(raw: string, label: string): ParsedRate {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, cents: null };
  if (trimmed.startsWith('-')) return { ok: false, problem: `${label} cannot be negative.` };
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false, problem: `${label} is dollars and cents, to at most two decimal places — 95 or 95.50.` };
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return { ok: false, problem: `${label} must be more than zero.` };
  }
  if (cents > RATE_MAX_CENTS) {
    return { ok: false, problem: `${label} is at most $5,000 an hour — check for an extra zero.` };
  }
  return { ok: true, cents };
}

/** The value a form shows for a rate: `''` for no rate, else dollars with two decimal places. */
export function rateInput(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}

/** The symbols a rate is written with; anything else keeps its ISO code. */
const SYMBOLS: Record<string, string> = {
  AUD: '$',
  NZD: 'NZ$',
  USD: 'US$',
  CAD: 'CA$',
  GBP: '£',
  EUR: '€',
};

/** Thousands separators, without a locale: the same bytes on every box. */
function grouped(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A rate as a person reads it: `$95.50/hour`, `$95/hour`, `US$1,200/hour`. `null` when there is no
 * rate — the caller says what that means in its own words ("discussed" on the profile, "rate on
 * application" on the board), because the two sentences are for different readers.
 */
export function hourlyRate(cents: number | null, currency: string): string | null {
  if (cents === null || !Number.isFinite(cents) || cents <= 0) return null;
  const code = currency.trim().toUpperCase() || 'AUD';
  const symbol = SYMBOLS[code];
  const whole = Math.trunc(cents / 100);
  const fraction = Math.abs(cents % 100);
  const amount = `${grouped(whole)}${fraction === 0 ? '' : `.${String(fraction).padStart(2, '0')}`}`;
  return `${symbol === undefined ? `${code} ` : symbol}${amount}/hour`;
}
