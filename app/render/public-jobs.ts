/**
 * The public board: `/jobs` and `/jobs/<id>`, drawn as the site's own pages.
 *
 * ## Why this is a renderer and not a package page
 *
 * A package can declare a detail page (`ctx.page`), and the job board does — `/jobs/{slug}`, a
 * title and escaped paragraphs. That is enough to prove the pattern works and not enough to be
 * the board: a visitor choosing a role needs the rate, how many days a week, where it is, whether
 * it is remote and when it was posted, and a list needs those same facts in every row. Those are
 * `p_jobboard_job` columns the package owns, so the host draws them from the same read the portal
 * uses (`app/accounts/jobs.ts`), through the facade, and never from SQL of its own.
 *
 * ## Why the markup is built here and not in a template
 *
 * The shell (`app/render/components/shells/page.astro`) is the site's only document: the header,
 * the sticky rules, `/theme.css`, `<main>`, the footer. It takes a **`PageRecord`-shaped body**,
 * and every page — a `cms_page`, a package's declared detail page, and now these two — arrives at
 * it the same way. So this module produces exactly what a page's body is (an escaped fragment),
 * and `renderPage` in `app/main.ts` hands it to the same shell with the same nav and chrome. There
 * is no second header in this file, which is the only way the two cannot drift apart.
 *
 * ## Class names
 *
 * The markup uses the site theme's own vocabulary (`.fw-band`, `.fw-h2`, `.fw-lede`, `.fw-cards`,
 * `.fw-card`, `.fw-actions`, `.fw-btn`, `.fw-note`). A page's own stylesheet would have to be a row
 * in `cms_css_blob` to be served (`style-src 'self'` forbids an inline `<style>`), and inventing
 * CSS for a page nothing authored is not this slice's job — reusing the theme is also what makes
 * the board look like the site rather than like a second product.
 *
 * ## What a visitor is told, and what is never said
 *
 * Every value is escaped text. An advert whose rate or availability the advertiser left empty says
 * "rate on application" / "days to be agreed" — never `null` and never `undefined`. A company row
 * that no longer exists says "Company not stated" rather than printing a number. Nothing here
 * knows an account id, an email address or a name of a person.
 */
import { escapeAttr, escapeText } from '../editor/html.ts';

import type { PublicAdvert } from '../accounts/jobs.ts';

/** The board's list. One path, spelled once. */
export const JOBS_PATH = '/jobs';

/** 20 adverts a page: five rows of the theme's four-column grid, and a page a person can scan. */
export const JOBS_PAGE_SIZE = 20;

/**
 * The highest page number the list will answer. `offset` is `(page - 1) * 20`, and the facade caps
 * an offset at 10 000; 500 pages is 10 000 adverts, far past any board this software serves, so a
 * page beyond it is a 404 rather than a clamped duplicate of the last one.
 */
export const JOBS_MAX_PAGE = 500;

/**
 * Is this path one a menu entry may point at without a `cms_page` row? `/jobs` is a core route, so
 * `loadNav` would otherwise refuse a "Jobs" item as a dead link.
 */
export function isPublicJobsPath(path: string): boolean {
  return path === JOBS_PATH;
}

/**
 * `?page=` → a page number, or `null` when it is out of the range this board answers.
 *
 * Absent, empty or nonsense is page 1: a query string is a visitor's, and a visitor who edits one
 * by hand should land on the board rather than on an error. A page above `JOBS_MAX_PAGE` is `null`
 * because it cannot name a page of adverts, and the caller turns that into the site's 404.
 */
export function pageNumber(url: string): number | null {
  const q = url.indexOf('?');
  const raw = q === -1 ? undefined : new URLSearchParams(url.slice(q + 1)).get('page');
  if (raw === null || raw === undefined || raw.trim() === '') return 1;
  const trimmed = raw.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return 1;
  const value = Number(trimmed);
  if (value < 1) return 1;
  if (value > JOBS_MAX_PAGE) return null;
  return value;
}

/* ------------------------------------------------------------------------------- formatting */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** The symbols a day rate is written with; anything else keeps its ISO code. */
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
 * A day rate as money. `null` is "rate on application" — the sentence the portal uses for a
 * profile's empty rate and the one an advertiser's empty field means.
 */
export function formatDayRate(cents: number | null, currency: string): string {
  if (cents === null || !Number.isFinite(cents) || cents <= 0) return 'rate on application';
  const code = currency.trim().toUpperCase() || 'AUD';
  const symbol = SYMBOLS[code];
  const whole = Math.trunc(cents / 100);
  const fraction = Math.abs(cents % 100);
  const amount = `${grouped(whole)}${fraction === 0 ? '' : `.${String(fraction).padStart(2, '0')}`}`;
  return `${symbol === undefined ? `${code} ` : symbol}${amount} a day`;
}

/** `2 days a week`, `1 day a week`, or `days to be agreed` when the advertiser left it empty. */
export function formatDays(days: number | null): string {
  if (days === null || !Number.isFinite(days) || days < 1) return 'days to be agreed';
  const n = Math.trunc(days);
  return `${String(n)} ${n === 1 ? 'day' : 'days'} a week`;
}

/** `12 October 2026`, or `date not stated` for a row with no usable timestamp. */
export function formatPosted(iso: string | null): string {
  if (iso === null) return 'date not stated';
  const day = iso.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return 'date not stated';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const name = MONTHS[month - 1];
  if (name === undefined || date < 1 || date > 31) return 'date not stated';
  return `${String(date)} ${name} ${String(year)}`;
}

/** The company a visitor reads, never a number. */
function company(job: PublicAdvert): string {
  return job.companyName.trim() === '' ? 'Company not stated' : job.companyName.trim();
}

function location(job: PublicAdvert): string {
  return job.location === '' ? 'Location not stated' : job.location;
}

function remote(job: PublicAdvert): string {
  return job.remoteOk ? 'Remote: yes' : 'Remote: no';
}

/* ------------------------------------------------------------------------------------ head */

/** `<title>` for the list. The site's name is the tenant's own (`cms_settings`), never a constant. */
export function jobsListTitle(siteName: string): string {
  return siteName.trim() === '' ? 'Jobs' : `Jobs — ${siteName.trim()}`;
}

/** `<title>` for one advert: the role and the company, which is what a person searching sees. */
export function jobDetailTitle(job: PublicAdvert, siteName: string): string {
  const site = siteName.trim();
  const subject = job.companyName.trim() === '' ? job.title : `${job.title} at ${company(job)}`;
  return site === '' ? subject : `${subject} — ${site}`;
}

/** The list's meta description: one sentence, and it counts the adverts it is describing. */
export function jobsListDescription(total: number, siteName: string): string {
  const site = siteName.trim();
  const where = site === '' ? 'the board' : site;
  if (total === 0) return `No open roles on ${where} yet. Companies post fractional roles measured in days per week; applicants apply directly.`;
  return `${String(total)} published fractional ${total === 1 ? 'role' : 'roles'} on ${where}, newest first: day rate, days a week, location and remote.`;
}

/** One advert's meta description: the same facts its page states, in one sentence. */
export function jobDetailDescription(job: PublicAdvert): string {
  const parts = [
    job.companyName.trim() === '' ? '' : ` at ${company(job)}`,
    ` — ${formatDayRate(job.dayRateCents, job.currency)}`,
    `, ${formatDays(job.daysPerWeek)}`,
    `, ${location(job)}`,
    job.remoteOk ? ', remote' : '',
    `, posted ${formatPosted(job.publishedAt)}`,
  ];
  const sentence = `${job.title}${parts.join('')}.`;
  return sentence.length <= 160 ? sentence : `${sentence.slice(0, 157)}…`;
}

/* ------------------------------------------------------------------------------------ body */

interface ListView {
  readonly page: number;
  readonly pages: number;
  readonly total: number;
}

/** One advert as a card in the list. */
function listCard(job: PublicAdvert): string {
  const facts = [
    company(job),
    formatDayRate(job.dayRateCents, job.currency),
    formatDays(job.daysPerWeek),
    location(job),
    remote(job),
  ].join(' · ');
  const summary =
    job.summary.trim() === '' ? '' : `\n      <p class="fw-card__body">${escapeText(job.summary.trim())}</p>`;
  return `<article class="fw-card">
      <p class="fw-card__mark">Posted ${escapeText(formatPosted(job.publishedAt))}</p>
      <h2 class="fw-card__title"><a href="${escapeAttr(`${JOBS_PATH}/${String(job.id)}`)}">${escapeText(job.title)}</a></h2>
      <p class="fw-card__body">${escapeText(facts)}</p>${summary}
    </article>`;
}

/** The empty board: what is true, and the two doors a visitor can use. */
function emptyBoard(): string {
  return `<section class="fw-band" id="jobs">
  <p class="fw-kicker">Open roles</p>
  <h1 class="fw-h2">No open roles yet.</h1>
  <p class="fw-lede">Nothing is published on the board today. Companies post fractional roles here as they open them, newest first, and each advert states its day rate, the days a week and where the work is done.</p>
  <div class="fw-actions">
    <a class="fw-btn fw-btn--primary" href="/portal/register?role=advertiser">Post a role</a>
    <a class="fw-btn fw-btn--ghost" href="/portal/register?role=applicant">Create an applicant profile</a>
  </div>
  <p class="fw-note">Hiring for part of a week? <a href="/portal/register?role=advertiser">Create a company account</a> and the first role you publish appears here.</p>
</section>`;
}

/** The list, with its pagination. */
export function jobsListBody(jobs: readonly PublicAdvert[], view: ListView): string {
  if (jobs.length === 0) return emptyBoard();
  const count =
    view.total === 1 ? 'One published role' : `${String(view.total)} published roles`;
  const pager =
    view.pages === 1
      ? ''
      : `
  <nav class="fw-actions" aria-label="Pagination">
    ${view.page > 1 ? `<a class="fw-btn fw-btn--ghost" href="${JOBS_PATH}?page=1">Newest</a>` : ''}
    ${view.page > 1 ? `<a class="fw-btn fw-btn--ghost" href="${JOBS_PATH}?page=${String(view.page - 1)}" rel="prev">Newer roles</a>` : ''}
    <span class="fw-card__mark">Page ${String(view.page)} of ${String(view.pages)}</span>
    ${view.page < view.pages ? `<a class="fw-btn fw-btn--ghost" href="${JOBS_PATH}?page=${String(view.page + 1)}" rel="next">Older roles</a>` : ''}
  </nav>`;
  return `<section class="fw-band" id="jobs">
  <p class="fw-kicker">Open roles</p>
  <h1 class="fw-h2">Roles on the board.</h1>
  <p class="fw-lede">${escapeText(count)}, newest first. Every one states its day rate, the days a week and where the work is done; the role itself is as the company wrote it.</p>
  <div class="fw-cards">
    ${jobs.map(listCard).join('\n    ')}
  </div>${pager}
  <p class="fw-note">Hiring for part of a week? <a href="/portal/register?role=advertiser">Post a role</a> and it appears here.</p>
</section>`;
}

/** One advert, in full. */
export function jobDetailBody(job: PublicAdvert): string {
  const facts: [string, string][] = [
    ['Day rate', formatDayRate(job.dayRateCents, job.currency)],
    ['Days a week', formatDays(job.daysPerWeek)],
    ['Location', location(job)],
    ['Remote', job.remoteOk ? 'yes' : 'no'],
    ['Posted', formatPosted(job.publishedAt)],
  ];
  const factCards = facts
    .map(
      ([label, value]) =>
        `<article class="fw-card">\n      <p class="fw-card__mark">${escapeText(label)}</p>\n      <p class="fw-card__body">${escapeText(value)}</p>\n    </article>`,
    )
    .join('\n    ');

  const summary = job.summary.trim() === '' ? '' : `\n  <p class="fw-lede">${escapeText(job.summary.trim())}</p>`;
  const paragraphs = job.body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => `<p>${escapeText(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  return `<article class="fw-band" id="role">
  <p class="fw-kicker">${escapeText(company(job))}</p>
  <h1 class="fw-h2">${escapeText(job.title)}</h1>${summary}
  <div class="fw-cards">
    ${factCards}
  </div>
  <div class="fw-prose">
${paragraphs}
  </div>
  <div class="fw-actions">
    <a class="fw-btn fw-btn--primary" href="/portal/applicant">Apply</a>
    <a class="fw-btn fw-btn--ghost" href="${JOBS_PATH}">All roles</a>
  </div>
  <p class="fw-note">Already signed in? <a href="/portal/applicant">Apply from your applicant page</a> with advert number ${String(job.id)}, and <a href="/portal/signin?next=/portal/applicant">sign in</a> first if you are not.</p>
</article>`;
}
