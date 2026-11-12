/**
 * The portal's HTTP surface — the transport around `Accounts`, and nothing else.
 *
 * Server-rendered, no JavaScript, like the admin: a form that posts and a page that answers. The
 * three rules every POST here obeys, in this order, because each one closes a different hole:
 *
 *   1. **Origin.** `Origin` must equal `https://<Host>`; a cleartext `X-Forwarded-Proto` is refused
 *      by name. A cookie is sent by the browser on a cross-site form post; this header is what makes
 *      that post useless to an attacker. `SameSite=Strict` on the cookie is the second lock on the
 *      same door, not a substitute for the first.
 *   2. **CSRF.** A signed-in POST carries the session's own `csrf_secret` in a body field or the
 *      `X-CSRF-Token` header. Registration and sign-in have no session to bind to, so they rely on
 *      origin + rate limiting — and they cannot do anything a stranger could not do anyway.
 *   3. **Tenant.** The cookie is named for the tenant (`__Secure-sk-portal-<key>`) and the path is
 *      `/portal`, so a cookie minted on one host is not even sent to another, and the row it names
 *      lives in that tenant's own `site.db`. The name is the check, not a comment about one.
 *
 * The enrolment cookie is the one piece of state that exists between "address proved" and "TOTP
 * confirmed": the person is not signed in yet, but they must be able to submit a code. It carries
 * the account id and an HMAC over it under `env.sessionKey`, lives 30 minutes, and is worth nothing
 * without a valid code — the code is still the second factor.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { CSRF_HEADER, cookieAttrs, cookieValue } from '../admin/session.ts';
import { escapeHtml } from '../admin/ui/html.ts';
import { normaliseHost } from '../tenancy/normalise-host.ts';
import { AppError, HTTP } from '../errors.ts';
import type { Env } from '../env.ts';
import { chromeHtml, loadChrome, logoUrl as chromeLogoUrl } from '../render/chrome.ts';
import { loadNav, navListHtml } from '../render/nav.ts';
import { PORTAL_CSS } from './portal-css.ts';
import type { Accounts, Role, SelfView } from './service.ts';
import { PASSWORD_MIN } from './service.ts';
import {
  ADVERTISER_STATUSES,
  applicationsForAdvertiser,
  applicationsForApplicant,
  applyForJob,
  OUTCOMES,
  OUTCOME_LABELS,
  OUTCOME_NOTE_MAX,
  outcomeLabel,
  recordOutcome,
  setApplicationStatus,
  withdrawApplication,
  type AdvertiserApplication,
  type ApplyOutcome,
  type ApplyRefusal,
  type AdvertiserStatus,
  type ApplicantApplication,
  type ApplicationStatus,
  type OutcomeRefusal,
} from './applications.ts';
import { advertReader, type PublicAdvert } from './jobs.ts';
import { hourlyRate, parseRateDollars, rateInput } from './money.ts';
import { normaliseSuburbCity, screenFreeText } from './pii.ts';
import {
  PROFILE_LIMITS,
  parseVisibility,
  parseWorkModes,
  profileEditProblem,
  WORK_MODES,
  WORK_MODE_LABELS,
  workModeLabel,
  workModesLabel,
  type ApplicantProfile,
  type ProfileEdit,
  type WorkModes,
} from './policy.ts';
import { loadProfile, saveProfile } from './profile.ts';

/** 30 minutes to finish a sign-up after clicking the link. */
export const ENROL_TTL_S = 30 * 60;

export function portalCookieName(tenantKey: string): string {
  return `__Secure-sk-portal-${tenantKey}`;
}

export function enrolCookieName(tenantKey: string): string {
  return `__Secure-sk-enrol-${tenantKey}`;
}

export const PORTAL_COOKIE_PATH = '/portal';

export interface PortalDeps {
  accounts: Accounts;
  env: Env;
  /**
   * An `admin-write` handle for the tenant, the same factory `Accounts` is given. The applicant and
   * advertiser pages read `cms_profile` and `cms_application` themselves; those two tables are this
   * module's business, and routing them through `Accounts` would put a profile writer on the class
   * that owns the sign-in state machine.
   */
  openDb(tenantKey: string): Database.Database;
  /** `SKW_EMAIL_MODE`; the plugin facade's context needs it, and so does the operator's screen. */
  emailMode: 'off' | 'smtp';
  /**
   * The tenant this request belongs to, resolved from the Host by the caller (`resolveRequest`).
   * Passed as a function rather than a value so the router never invents a tenant of its own.
   */
  tenantOf(req: FastifyRequest): string;
  /**
   * Whether a path is served by a loaded package rather than a `cms_page` row.
   *
   * The header's menu is the site's menu, and a tenant may point it at `/jobs` — a row in the job
   * board's own table, which `cms_page` has never heard of. The CMS render path passes exactly this
   * predicate to `loadNav`; the portal must pass the same one or its header would refuse a link the
   * marketing pages happily draw. Optional because a test harness has no plugin runtime.
   */
  pageExists?(tenantKey: string, path: string): boolean;
  /** Off when real SMTP is configured; on offline, so the page can show the operator's link. */
  exposeVerifyLink?: boolean;
}

/**
 * A body, as fields. The app's urlencoded parser hands this route the raw string (the same choice
 * the admin login makes — no extra dependency), while a JSON client hands an object, and a browser
 * with two checked boxes hands the same key twice. All three are read here, once.
 */
type Fields = Record<string, string[]>;

function fieldsOf(body: unknown): Fields {
  const out: Record<string, string[]> = {};
  const push = (key: string, value: string): void => {
    (out[key] ??= []).push(value);
  };
  if (typeof body === 'string') {
    for (const [key, value] of new URLSearchParams(body)) push(key, value);
    return out;
  }
  if (typeof body !== 'object' || body === null) return out;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string') push(key, value);
    else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') push(key, item);
  }
  return out;
}

/** The first value of a field, or `''`. A single-valued field is the only kind most routes read. */
function field(fields: Fields, name: string): string {
  return fields[name]?.[0] ?? '';
}

function header(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name];
  return typeof raw === 'string' ? raw : undefined;
}

/** The hidden field every writing form carries. One implementation, so no form can forget it. */
function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

/**
 * A rate as money, the one way this product writes one. `null` is "discussed" — a person who left
 * the field empty has said something, and rendering `$0.00/hour` would say the opposite.
 */
function money(cents: number | null, currency: string): string {
  return hourlyRate(cents, currency) ?? 'discussed';
}

function days(n: number | null): string {
  return n === null ? 'not stated' : `${n} ${n === 1 ? 'day' : 'days'} a week`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** `Submitted`, `Withdrawn`, … — what a person reads in their own table. */
function stateWord(status: ApplicationStatus | string): string {
  return status === '' ? '' : status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * The state as the advertiser's table shows it. `withdrawn` is the one state that is theirs to
 * notice rather than to act on, so it is written in the case that stops a reader: `WITHDRAWN`.
 */
function stateCell(status: ApplicationStatus): string {
  return status === 'withdrawn'
    ? '<div class="state portal-state--withdrawn">WITHDRAWN</div>'
    : `<div class="state">${escapeHtml(status)}</div>`;
}

/**
 * The advert's title as the way to the advert.
 *
 * `/jobs/<id>` is the public board's own path — the role page, not a portal view of it — so a click
 * leaves the applicant's own table for the thing the row is about. A row whose advert can no longer
 * be read still links by its number, because the application happened either way.
 */
function roleLink(jobId: number, title: string | null): string {
  const href = `/jobs/${String(jobId)}`;
  return title === null
    ? `<a href="${href}">#${String(jobId)}</a>`
    : `<a href="${href}">${escapeHtml(title)}</a> <small>#${String(jobId)}</small>`;
}

/**
 * A post-sign-in destination, or `null` when it is not one of this host's own paths.
 *
 * `?next=` is a visitor's string, and a redirect that echoes it is the classic open redirect: a
 * `https://evil.test` target turns this sign-in form into a convincing phishing page, and a
 * `//evil.test` one does the same with two characters. Only an absolute **path** on this origin is
 * accepted — one leading slash, no scheme, no host, no backslash (some parsers read `\` as `/`), no
 * control characters — and the answer is re-derived from the parsed URL so what is redirected to is
 * the path and query, not the string that was typed.
 */
function localPath(raw: string): string | null {
  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, 'https://portal.invalid');
    if (url.origin !== 'https://portal.invalid') return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * Where a signed-in account belongs: its own portal, not a landing page that asks it to click again.
 *
 * An applicant goes to their applications; an advertiser to the applications they received. An
 * account holding **both** roles lands on the applicant side — the page that carries the work and
 * the switch — because a person with both roles is usually applying, and the advertiser side is one
 * click away from there (`portalBar`). `/portal` stays as the account page (account type, sign out)
 * for a session that holds neither role; it is no longer where a sign-in lands.
 */
function homeFor(roles: readonly Role[]): string {
  if (roles.includes('applicant')) return '/portal/applicant';
  if (roles.includes('advertiser')) return '/portal/advertiser';
  return '/portal';
}

/** The form's boolean: a checkbox, a select, or a client that sent `true`. */
function truthy(raw: string): boolean {
  return ['1', 'on', 'yes', 'true'].includes(raw.toLowerCase());
}

type ParsedInt = { readonly ok: true; readonly value: number | null } | { readonly ok: false; readonly problem: string };

/**
 * An optional whole number. Empty is `null` (the column allows it, and "not stated" is an answer);
 * anything that is not an integer is a sentence, never `NaN` on its way into a CHECK.
 */
function optionalInt(raw: string, label: string): ParsedInt {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^-?\d{1,12}$/.test(trimmed)) return { ok: false, problem: `${label} must be a whole number.` };
  return { ok: true, value: Number(trimmed) };
}

/** `selected` on the option the row already holds — the form shows the person their own state. */
function selected(when: boolean): string {
  return when ? ' selected' : '';
}

/** The same, for a radio: one of the three arrangements is the one this profile holds. */
function checked(when: boolean): string {
  return when ? ' checked' : '';
}

type ParsedEdit = { readonly ok: true; readonly edit: ProfileEdit } | { readonly ok: false; readonly problem: string };

/**
 * `POST /portal/applicant/profile`, from fields to a `ProfileEdit`.
 *
 * Every value is read once, here, and the four refusals a browser can produce without JavaScript
 * (a non-number, a state outside the vocabulary, a name that is only spaces, a headline past its
 * bound) are sentences. `profileEditProblem` in `policy.ts` is the authority on the last two; this
 * function only turns strings into the types that function takes.
 */
function profileEditFrom(fields: Fields): ParsedEdit {
  const visibility = parseVisibility(field(fields, 'visibility'));
  if (visibility === null) return { ok: false, problem: 'Choose discoverable or hidden.' };
  // Dollars in, cents out: the form asks for an hourly rate and the column holds cents. The field
  // is named `hourly_rate`, not `hourly_rate_cents` — the person types 95.50, and the HTML should
  // not tell them otherwise.
  const rate = parseRateDollars(field(fields, 'hourly_rate'), 'The hourly rate');
  if (rate.ok === false) return rate;
  // The locality is capped at suburb/city by the same function that decides what counts as a
  // street address: an address typed here is refused, not silently stored.
  const locality = normaliseSuburbCity(field(fields, 'location'));
  if (locality.ok === false) {
    return { ok: false, problem: `Location: ${locality.reason === 'street' ? 'use the suburb or city only — no street address' : locality.reason === 'digits' ? 'use the suburb or city, not a number' : 'that is too long for a suburb or city'}.` };
  }
  // The arrangement is a SET: checkboxes post one value per ticked box under the same name, and
  // `parseWorkModes` collapses duplicates, refuses a word outside the vocabulary and returns the
  // set in `WORK_MODES` order. An empty post is `[]`, which `profileEditProblem` refuses below with
  // the sentence the person sees.
  const workModes = parseWorkModes(fields.work_modes ?? []);
  if (workModes === null) return { ok: false, problem: 'A work arrangement is on-site, hybrid or remote.' };
  const availability = optionalInt(field(fields, 'availability_days_per_week'), 'Availability');
  if (availability.ok === false) return availability;
  const headline = field(fields, 'headline').trim();
  const summary = field(fields, 'summary').trim();
  const edit: ProfileEdit = {
    displayName: field(fields, 'display_name'),
    headline: headline === '' ? null : headline,
    summary: summary === '' ? null : summary,
    hourlyRateCents: rate.cents,
    availabilityDaysPerWeek: availability.value,
    location: locality.value === '' ? null : locality.value,
    workModes,
    visibility,
    // Off unless the box says otherwise: the column defaults to 0 and `mayNotify` requires it.
    notifyNewJobs: truthy(field(fields, 'notify_new_jobs')),
  };
  const problem = profileEditProblem(edit);
  return problem === null ? { ok: true, edit } : { ok: false, problem };
}

/** The date a person reads. The row's timestamp is ISO; the page shows its day. */
function day(iso: string): string {
  return escapeHtml(iso.slice(0, 10));
}

/**
 * How wide a portal page's content column is.
 *
 * `auth` is a sign-in/register card, `regular` is the account page, `wide` is a dashboard with a
 * table in it. The shell (header, footer, `<main>`) is the site's; only the column inside it
 * changes, which is what keeps a portal page looking like a page of this website.
 */
type PortalWidth = 'auth' | 'regular' | 'wide';

const WIDTH_CLASS: Record<PortalWidth, string> = {
  auth: 'portal-container portal-container--auth',
  regular: 'portal-container',
  wide: 'portal-container portal-container--wide',
};

/**
 * The bar under a portal heading: the way to the other side of the board when the account holds
 * both roles, and the way out. Both sit on the page a person is already reading, so neither is a
 * guess about where they came from — and the switch is one click, which is the whole point of
 * landing a two-role account on the applicant side.
 */
function portalBar(csrf: string, other: { readonly href: string; readonly label: string } | null): string {
  const switchLink =
    other === null
      ? ''
      : `<a class="portal-button portal-button--quiet portal-button--small" href="${escapeHtml(other.href)}">${escapeHtml(other.label)}</a>`;
  return `<div class="portal-bar">
  ${switchLink}
  <form class="portal-signout" method="post" action="/portal/signout">
    ${csrfField(csrf)}
    <button class="portal-button portal-button--quiet portal-button--small" type="submit">Sign out</button>
  </form>
</div>`;
}

/**
 * The three arrangements, as **checkboxes**: what this applicant will accept, any combination.
 *
 * A checkbox group posts one `work_modes` value per ticked box — the same name repeated — which is
 * what makes the set expressible without JavaScript. `checked` marks the boxes this profile already
 * holds, and the legend says "at least one", because the validator refuses an empty set and the form
 * should say so before the post rather than after it.
 */
function workModeCheckboxes(current: WorkModes): string {
  const options = WORK_MODES.map(
    (mode) =>
      `<label class="portal-check"><input type="checkbox" name="work_modes" value="${mode}"${checked(current.includes(mode))}> ${escapeHtml(WORK_MODE_LABELS[mode])}</label>`,
  ).join('\n    ');
  return `<fieldset class="portal-fieldset">
    <legend>Work arrangements you will accept (at least one)</legend>
    ${options}
  </fieldset>`;
}

/** One application row's action cell: a withdraw form, or the sentence a withdrawn row earns. */
function withdrawCell(row: ApplicantApplication, csrf: string): string {
  if (row.status === 'withdrawn') return '<span class="portal-note">No further action</span>';
  return `<form class="portal-inline" method="post" action="/portal/applicant/withdraw">
  <input type="hidden" name="application_id" value="${row.id}">
  ${csrfField(csrf)}
  <button class="portal-button portal-button--quiet portal-button--small" type="submit">Withdraw</button>
</form>`;
}

/**
 * The applicant's Outcome cell: the company's decision in words, or the sentence that says there is
 * none yet.
 *
 * A withdrawn row reads `Not applicable` — not because a stored outcome was erased, but because a
 * decision about an application that no longer exists is not a fact about this person's week. The
 * advertiser's record stays in the row; the applicant's page simply stops reporting it.
 */
function applicantOutcomeCell(row: ApplicantApplication): string {
  if (row.status === 'withdrawn') return '<span class="portal-note">Not applicable</span>';
  const words = `<span class="portal-state">${escapeHtml(outcomeLabel(row.outcome))}</span>`;
  if (row.outcomeNote === null) return words;
  return `${words}<div class="portal-note">${escapeHtml(row.outcomeNote)}</div>`;
}

/**
 * The advertiser's Outcome cell: what has been recorded, and the form that records or replaces it.
 *
 * A withdrawn application has **no controls**: the applicant ended the conversation, and a decision
 * recorded afterwards would be a decision nobody is waiting for. The words stay, because a pipeline
 * that forgets what was concluded the day before a withdrawal is a pipeline that lies.
 *
 * The form carries the session's CSRF token like every other writing form here, and the note is
 * bounded in the markup at the column's own 500 so the browser refuses an over-long note before the
 * POST does.
 */
function advertiserOutcomeCell(row: AdvertiserApplication, csrf: string): string {
  if (row.status === 'withdrawn') {
    const was = row.outcome === null ? '' : ` The last outcome recorded was ${outcomeLabel(row.outcome)}.`;
    return `<span class="portal-note">Not applicable — withdrawn by the applicant.${escapeHtml(was)}</span>`;
  }
  const recorded =
    row.outcome === null
      ? '<div class="portal-note">Not decided yet</div>'
      : `<div class="state">${escapeHtml(outcomeLabel(row.outcome))}</div>` +
        (row.outcomeAt === null ? '' : `<div class="portal-note">recorded ${day(row.outcomeAt)}</div>`) +
        (row.outcomeNote === null ? '' : `<div class="summary">${escapeHtml(row.outcomeNote)}</div>`);
  const options = OUTCOMES.map(
    (outcome) => `<option value="${outcome}"${selected(row.outcome === outcome)}>${escapeHtml(OUTCOME_LABELS[outcome])}</option>`,
  ).join('');
  return `${recorded}<form class="portal-outcome" method="post" action="/portal/advertiser/outcome">
  <input type="hidden" name="application_id" value="${row.id}">
  ${csrfField(csrf)}
  <select name="outcome" aria-label="Outcome for this application">${options}</select>
  <input name="outcome_note" maxlength="${OUTCOME_NOTE_MAX}" placeholder="Note for the applicant (optional)" aria-label="Outcome note">
  <button class="portal-button portal-button--quiet portal-button--small" type="submit">Record outcome</button>
</form>`;
}

/**
 * `GET /portal/applicant` — the applicant's own record and their own rows, on one page.
 *
 * The page is a form and a table. It renders **no** value it did not read from this account's own
 * rows: `cms_profile` for the summary and `cms_application WHERE applicant_account_id = ?` for the
 * list. The CSRF token is the session's, so every form below cannot be posted from another origin
 * even with the cookie attached.
 *
 * There is no "apply" form here. An application names an advert, and an advert is a page: the
 * person applies from the role itself (`/jobs/<id>/apply`), where the thing they are applying for
 * is in front of them. Asking a person to type an id was asking them to remember a number the
 * board could carry for them.
 */
function applicantPage(
  profile: ApplicantProfile,
  applications: readonly ApplicantApplication[],
  csrf: string,
  opts: { readonly alsoAdvertises: boolean; readonly flash: string | null },
): string {
  const skills = profile.skills.length === 0
    ? '<li>none listed</li>'
    : profile.skills.map((skill) => `<li>${escapeHtml(skill)}</li>`).join('');
  // A profile link is a string a person typed. It is rendered as text, never as an `href`: a scheme
  // this page did not vet must not become a click that leaves the tenant's origin.
  const links = profile.links.length === 0
    ? '<li>none listed</li>'
    : profile.links
        .map((link) => `<li>${escapeHtml(link.label)} — ${escapeHtml(link.url)}</li>`)
        .join('');

  const rows = applications
    .map(
      (row) =>
        `<tr><td data-label="Role">${roleLink(row.jobId, row.jobTitle)}</td>` +
        `<td data-label="State"><span class="portal-state">${escapeHtml(stateWord(row.status))}</span></td>` +
        `<td data-label="Outcome">${applicantOutcomeCell(row)}</td>` +
        `<td data-label="Sent">${day(row.createdAt)}</td>` +
        `<td data-label="Action">${withdrawCell(row, csrf)}</td></tr>`,
    )
    .join('\n');

  // An empty table is a header row over nothing. A person with no applications gets a sentence
  // instead — the same sentence the page has always carried, in a box that reads as an answer.
  const applicationsBlock =
    applications.length === 0
      ? '<p class="portal-empty">You have not applied for anything yet.</p>'
      : `<div class="portal-table-scroll">
<table class="portal-table">
  <thead><tr><th scope="col">Role</th><th scope="col">State</th><th scope="col">Outcome</th><th scope="col">Sent</th><th scope="col">Action</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>`;

  const flash =
    opts.flash === null
      ? ''
      : `<p class="portal-banner portal-banner--success" role="status">${opts.flash}</p>\n`;

  return `<div class="portal-intro">
  <p class="portal-eyebrow">Applicant</p>
  <h1>Your applications</h1>
  <p class="portal-lede">Signed in as <strong>${escapeHtml(profile.displayName)}</strong>.</p>
</div>
${portalBar(csrf, opts.alsoAdvertises ? { href: '/portal/advertiser', label: 'Switch to advertising' } : null)}
${flash}<section>
<h2>Your profile</h2>
<p class="portal-note">Advertisers never see your email address, your phone number or any postal address — the board has no column for one. They see the fields below, and only when you apply to their advert or your profile is discoverable.</p>
<dl class="portal-profile">
  <dt>Name</dt><dd>${escapeHtml(profile.displayName)}</dd>
  <dt>Headline</dt><dd>${profile.headline === null ? '—' : escapeHtml(profile.headline)}</dd>
  <dt>Summary</dt><dd>${profile.summary === null ? '—' : escapeHtml(profile.summary)}</dd>
  <dt>Hourly rate</dt><dd>${money(profile.hourlyRateCents, profile.currency)}</dd>
  <dt>Availability</dt><dd>${days(profile.availabilityDaysPerWeek)}</dd>
  <dt>Work arrangements</dt><dd>${escapeHtml(workModesLabel(profile.workModes))}</dd>
  <dt>Discoverability</dt><dd>${escapeHtml(profile.visibility)}</dd>
  <dt>Emailed about new roles</dt><dd>${yesNo(profile.notifyNewJobs)}</dd>
  <dt>Skills</dt><dd><ul>${skills}</ul></dd>
  <dt>Links</dt><dd><ul>${links}</ul></dd>
</dl>
</section>

<section>
<h2>Edit your profile</h2>
<form class="portal-form portal-card" method="post" action="/portal/applicant/profile">
  ${csrfField(csrf)}
  <div class="portal-field">
    <label for="display_name">Name shown on your profile</label>
    <input id="display_name" name="display_name" value="${escapeHtml(profile.displayName)}" maxlength="${PROFILE_LIMITS.displayName}" required>
  </div>
  <div class="portal-field">
    <label for="headline">Headline</label>
    <input id="headline" name="headline" value="${escapeHtml(profile.headline ?? '')}" maxlength="${PROFILE_LIMITS.headline}">
  </div>
  <div class="portal-field">
    <label for="summary">Summary</label>
    <textarea id="summary" name="summary" rows="6" maxlength="${PROFILE_LIMITS.summary}">${escapeHtml(profile.summary ?? '')}</textarea>
  </div>
  <div class="portal-field">
    <label for="hourly_rate">Hourly rate (${escapeHtml(profile.currency)})</label>
    <input id="hourly_rate" name="hourly_rate" type="number" inputmode="decimal" min="0.01" max="5000" step="0.01" value="${rateInput(profile.hourlyRateCents)}">
    <p class="portal-hint">Dollars an hour — 95 or 95.50. Leave it empty for “discussed”.</p>
  </div>
  <div class="portal-field">
    <label for="availability_days_per_week">Days a week you are available</label>
    <input id="availability_days_per_week" name="availability_days_per_week" type="number" min="1" max="7" step="1" value="${profile.availabilityDaysPerWeek === null ? '' : String(profile.availabilityDaysPerWeek)}">
  </div>
  <div class="portal-field">
    <label for="location">Suburb or city</label>
    <input id="location" name="location" value="${profile.location === null ? '' : escapeHtml(profile.location)}" maxlength="80" placeholder="Newcastle NSW" aria-describedby="location-help">
    <p class="portal-note" id="location-help">Suburb or city only — no street address. This is shown to advertisers as a locality, never as a place to find you.</p>
  </div>
  ${workModeCheckboxes(profile.workModes)}
  <div class="portal-field">
    <label for="visibility">Discoverability</label>
    <select id="visibility" name="visibility">
      <option value="discoverable"${selected(profile.visibility === 'discoverable')}>discoverable — my profile may be matched against new roles</option>
      <option value="hidden"${selected(profile.visibility === 'hidden')}>hidden — not matched, and I cannot apply</option>
    </select>
  </div>
  <div class="portal-field">
    <label for="notify_new_jobs">Email me when a matching role is posted</label>
    <select id="notify_new_jobs" name="notify_new_jobs">
      <option value="1"${selected(profile.notifyNewJobs)}>yes</option>
      <option value="0"${selected(!profile.notifyNewJobs)}>no</option>
    </select>
  </div>
  <div class="portal-actions"><button class="portal-button" type="submit">Save profile</button></div>
</form>
</section>

<section>
<h2>Your applications</h2>
${applicationsBlock}
<p class="portal-note">Applying starts on the role itself: open it on the <a href="/jobs">board</a> and press “Apply now”. The advert comes with you, so there is nothing to copy and no id to type.</p>
</section>`;
}

/**
 * `GET /portal/advertiser` — the applications to this advertiser's own adverts.
 *
 * Every applicant cell is a `ProfileProjection`, which has no email, no phone and no address field
 * at all. The name and the rate below are the applicant's own choices; the “why you can see this”
 * line is the projection's `basis`, rendered as a note rather than as data. A row whose profile is
 * unavailable shows the application and no person: the board does not fall back to the account.
 *
 * A **withdrawn** row stays on the page and says `WITHDRAWN` in the state it was received in: an
 * advertiser who shortlisted somebody and then saw them withdraw needs to see that it happened, not
 * watch the row disappear. What it never does is count: the line above the table counts the rows
 * still awaiting a decision, and a withdrawn application is not one of them — nor can it be decided
 * (`withdrawApplication` ends it, and `setApplicationStatus` refuses to reopen it).
 */
function advertiserPage(
  displayName: string,
  applications: readonly AdvertiserApplication[],
  csrf: string,
  opts: { readonly alsoApplies: boolean },
): string {
  // The actionable count is derived here, from the same array the table is drawn from, so a row
  // cannot be counted as actionable and rendered as ended (or the reverse).
  const awaiting = applications.filter((row) => row.status === 'submitted').length;
  const withdrawn = applications.filter((row) => row.status === 'withdrawn').length;
  const rows = applications
    .map((row) => {
      const profile = row.profile;
      // The note says *why* this viewer may see the profile, and it is read off the projection
      // (`basis`) rather than asserted here: if the policy ever answers an advertiser for a
      // different reason, this line follows it instead of lying about it.
      const who = profile === null
        ? '<span class="portal-note">This applicant\'s profile is not available.</span>'
        : `<strong>${escapeHtml(profile.displayName)}</strong>` +
          (profile.headline === null ? '' : `<div>${escapeHtml(profile.headline)}</div>`) +
          (profile.summary === null ? '' : `<div class="summary">${escapeHtml(profile.summary)}</div>`) +
          `<div>${money(profile.hourlyRateCents, profile.currency)} · ${days(profile.availabilityDaysPerWeek)} · work: ${escapeHtml(workModesLabel(profile.workModes))}</div>` +
          (profile.location === null ? '' : `<div>${escapeHtml(profile.location)}</div>`) +
          (profile.skills.length === 0 ? '' : `<div>skills: ${profile.skills.map((s) => escapeHtml(s)).join(', ')}</div>`) +
          // A link is a string the applicant typed: rendered as text, never as an `href`.
          (profile.links.length === 0
            ? ''
            : `<div>links: ${profile.links.map((l) => `${escapeHtml(l.label)} — ${escapeHtml(l.url)}`).join('; ')}</div>`) +
          `<div class="basis">${escapeHtml(
            profile.basis === 'application' ? 'visible because they applied to this role' : `visible as ${profile.basis}`,
          )}</div>`;
      const note = row.coverNote === null ? '<span class="portal-note">no note</span>' : escapeHtml(row.coverNote);
      const decision = row.status === 'withdrawn'
        ? '<span class="portal-note">withdrawn by the applicant</span>'
        : `<form class="portal-decisions" method="post" action="/portal/advertiser/application">
             <input type="hidden" name="application_id" value="${row.id}">
             ${csrfField(csrf)}
             <button class="portal-button portal-button--quiet portal-button--small" type="submit" name="status" value="shortlisted">Shortlist</button>
             <button class="portal-button portal-button--danger portal-button--small" type="submit" name="status" value="rejected">Reject</button>
           </form>`;
      return `<tr><td data-label="Role">${roleLink(row.jobId, row.jobTitle)}</td>` +
        `<td data-label="Applicant">${who}</td>` +
        `<td data-label="What they said">${note}</td>` +
        `<td data-label="Received">${day(row.createdAt)}${stateCell(row.status)}</td>` +
        `<td data-label="Outcome">${advertiserOutcomeCell(row, csrf)}</td>` +
        `<td data-label="Decision">${decision}</td></tr>`;
    })
    .join('\n');

  const applicationsBlock =
    applications.length === 0
      ? '<p class="portal-empty">No applications yet. When someone applies to one of your roles it appears here.</p>'
      : `<div class="portal-table-scroll">
<table class="portal-table">
  <thead><tr><th scope="col">Role</th><th scope="col">Applicant</th><th scope="col">What they said</th><th scope="col">Received</th><th scope="col">Outcome</th><th scope="col">Decision</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>`;

  const counts =
    applications.length === 0
      ? ''
      : `<p class="portal-note" data-awaiting="${awaiting}" data-withdrawn="${withdrawn}">${awaiting} awaiting your decision · ${withdrawn} withdrawn. A withdrawn application is closed: it is not counted above and cannot be shortlisted or rejected.</p>\n`;

  return `<div class="portal-intro">
  <p class="portal-eyebrow">Advertiser</p>
  <h1>Applications to your roles</h1>
  <p class="portal-lede">Signed in as <strong>${escapeHtml(displayName)}</strong>.</p>
</div>
${portalBar(csrf, opts.alsoApplies ? { href: '/portal/applicant', label: 'Switch to applying' } : null)}
<p class="portal-note">Applicants are shown as they chose to be seen. The board never sends you an email address, a phone number or a postal address, and there is no field on this page that could carry one.</p>
<p class="portal-note">An <strong>outcome</strong> is your own record of what you concluded. It is shown to the applicant beside the application's state and never changes that state: shortlisting an application does not move it out of “submitted”, and only the applicant can withdraw it.</p>
${counts}${applicationsBlock}`;
}

/** An id from a query string or a path, or `null` — never `NaN`, never a coercion of prose. */
function numericId(raw: unknown): number | null {
  const text = String(raw ?? '').trim();
  if (!/^\d{1,9}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The success banner's sentence, from `?applied=<jobId>`.
 *
 * The id is the flash's only state: no session field, no cookie, nothing to clear. It names the
 * role when the advert can still be read and says the plain thing when it cannot — a role closed
 * between the application and the redirect is still an application that was sent.
 */
function appliedFlash(jobId: number | null, title: string | null): string | null {
  if (jobId === null) return null;
  return title === null
    ? 'Your application has been sent.'
    : `Your application for <strong>${escapeHtml(title)}</strong> has been sent.`;
}

/**
 * The refusal a cover note earns, or `null`. The note itself is what a stranger wrote; the reason
 * is a category, and the sentence names what must not be in it. `screenFreeText` returns the value
 * unchanged when it passes, which is the only way this can be a screen rather than an editor.
 */
function coverNoteRefusal(note: string): string | null {
  if (note === '') return null;
  const screened = screenFreeText(note);
  if (screened.ok) return null;
  const what =
    screened.reason === 'email'
      ? 'an email address'
      : screened.reason === 'phone'
        ? 'a phone number'
        : screened.reason === 'address'
          ? 'a postal address'
          : 'a tax file number, a bank account or another sensitive number';
  return `A cover note cannot contain ${what}: the advertiser never receives contact details here, and nothing was sent.`;
}

/**
 * The refusal an outcome earns, as a sentence. `not_found` and `withdrawn` are answered by their own
 * status codes; the rest are 400s whose sentence names the one thing that must change. A refused note
 * never reaches the row, so the applicant's page never has to hold a number it should not.
 */
function outcomeRefusal(reason: OutcomeRefusal): AppError {
  switch (reason) {
    case 'not_found':
      return new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such application for this account');
    case 'withdrawn':
      return new AppError(
        'SKW_E_PLT_REQUEST_INVALID',
        'the applicant withdrew this application; an outcome is not yours to record on it',
      );
    case 'unknown_outcome':
      return new AppError('SKW_E_PLT_REQUEST_INVALID', 'An outcome is shortlisted, interview, offer or rejected.');
    case 'note_too_long':
      return new AppError('SKW_E_PLT_REQUEST_INVALID', `An outcome note is at most ${OUTCOME_NOTE_MAX} characters.`);
    case 'note_email':
      return new AppError(
        'SKW_E_PLT_REQUEST_INVALID',
        'An outcome note cannot contain an email address: the applicant reads this note, and the board never carries contact detail.',
      );
    case 'note_phone':
      return new AppError(
        'SKW_E_PLT_REQUEST_INVALID',
        'An outcome note cannot contain a phone number: the applicant reads this note, and the board never carries contact detail.',
      );
    case 'note_address':
      return new AppError(
        'SKW_E_PLT_REQUEST_INVALID',
        'An outcome note cannot contain a postal address: the applicant reads this note, and the board never carries contact detail.',
      );
    case 'note_sensitive':
      return new AppError(
        'SKW_E_PLT_REQUEST_INVALID',
        'An outcome note cannot contain a tax file number, a bank account, a health or other sensitive detail.',
      );
  }
}

/**
 * `GET /jobs/<id>/apply` — the confirmation page, as the site's own document.
 *
 * It states the four facts a person needs before they press the button — the role, the company, the
 * hourly rate and the work arrangement — because those are the four the advert is judged on, and
 * asking somebody to confirm an application to a numbered row they cannot see is not a
 * confirmation. One optional note, one button, no JavaScript: a textarea and a POST.
 */
function applyPageBody(state: {
  readonly advert: PublicAdvert;
  readonly csrf: string;
  readonly note: string;
  readonly problem: string | null;
}): string {
  const { advert } = state;
  const rate = hourlyRate(advert.hourlyRateCents, advert.currency) ?? 'rate on application';
  const company = advert.companyName.trim() === '' ? 'Company not stated' : advert.companyName.trim();
  const banner =
    state.problem === null ? '' : `<p class="portal-banner portal-banner--error" role="alert">${escapeHtml(state.problem)}</p>\n`;
  return `<div class="portal-intro">
  <p class="portal-eyebrow">Apply</p>
  <h1>Apply for ${escapeHtml(advert.title)}</h1>
  <p class="portal-lede">Your profile goes with this application, and only to this company. Nothing is sent until you press the button.</p>
</div>
${banner}<div class="portal-panel">
<dl class="portal-profile">
  <dt>Role</dt><dd>${escapeHtml(advert.title)}</dd>
  <dt>Company</dt><dd>${escapeHtml(company)}</dd>
  <dt>Hourly rate</dt><dd>${escapeHtml(rate)}</dd>
  <dt>Work arrangement</dt><dd>${escapeHtml(workModeLabel(advert.workMode))}</dd>
</dl>
</div>
<form class="portal-form portal-card" method="post" action="/portal/jobs/${String(advert.id)}/apply">
  ${csrfField(state.csrf)}
  <div class="portal-field">
    <label for="cover_note">What you would bring to it (optional)</label>
    <textarea id="cover_note" name="cover_note" rows="8" maxlength="${PROFILE_LIMITS.coverNote}">${escapeHtml(state.note)}</textarea>
    <p class="portal-hint">Free text, in your own words. Leave out your email address, your phone number and any postal address — the advertiser never receives them here.</p>
  </div>
  <div class="portal-actions"><button class="portal-button" type="submit">Submit application</button></div>
</form>
<p class="portal-aside"><a href="/jobs/${String(advert.id)}">Back to the role</a> · <a href="/portal/applicant">Your applications</a></p>`;
}

/**
 * One named refusal per way an application can be refused. The names are the product's answers, not
 * the database's: "already applied" is a 409 because the row exists, "hidden" is a 403 because the
 * person can fix it, and a closed advert is a 400 that says which state it is in.
 */
function applyRefusal(outcome: { readonly reason: ApplyRefusal; readonly advertStatus?: string }): AppError {
  switch (outcome.reason) {
    case 'job_unknown':
      return new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'that advert is not on this board');
    case 'job_not_open':
      return new AppError(
        'SKW_E_PLT_REQUEST_INVALID',
        `that advert is ${outcome.advertStatus ?? 'not published'} — it is not open for applications`,
      );
    case 'own_advert':
      return new AppError('SKW_E_SEC_FORBIDDEN', 'that advert is your own; you cannot apply to it');
    case 'duplicate':
      return new AppError('SKW_E_DM_KEY_IN_USE', 'you have already applied for that advert');
    case 'profile_hidden':
      return new AppError('SKW_E_SEC_FORBIDDEN', 'your profile is hidden — make it discoverable before applying');
    case 'no_profile':
      return new AppError('SKW_E_PLT_REQUEST_INVALID', 'this account has no profile to send');
    case 'cover_note_too_long':
      return new AppError(
        'SKW_E_PLT_REQUEST_INVALID',
        `a cover note is at most ${PROFILE_LIMITS.coverNote} characters`,
      );
  }
}

class Portal {
  readonly #deps: PortalDeps;

  constructor(deps: PortalDeps) {
    this.#deps = deps;
  }

  #tenant(req: FastifyRequest): string {
    return this.#deps.tenantOf(req);
  }

  #ip(req: FastifyRequest): string {
    return req.socket.remoteAddress ?? '';
  }

  /**
   * Origin first, then CSRF when there is a session. Both refusals are the same code, because the
   * difference between them is the attacker's business and not the browser's.
   */
  #assertOrigin(req: FastifyRequest): void {
    const proto = header(req, 'x-forwarded-proto');
    if (proto !== undefined && proto.toLowerCase() !== 'https') {
      throw new AppError('SKW_E_SEC_CSRF', `the portal requires https: this request arrived over ${proto}`);
    }
    const origin = header(req, 'origin');
    const host = normaliseHost(req.headers.host ?? null);
    const expected = host === null ? null : `https://${host}`;
    if (origin === undefined || expected === null || origin !== expected) {
      throw new AppError('SKW_E_SEC_CSRF', 'origin does not match the host this request was sent to');
    }
  }

  #assertCsrf(req: FastifyRequest, csrf: string | null): void {
    if (csrf === null) throw new AppError('SKW_E_SEC_CSRF', 'not signed in');
    const submitted = header(req, CSRF_HEADER) ?? field(fieldsOf(req.body), 'csrf');
    if (submitted === undefined || submitted.length !== csrf.length) {
      throw new AppError('SKW_E_SEC_CSRF', 'missing or wrong csrf token');
    }
    if (!timingSafeEqual(Buffer.from(submitted), Buffer.from(csrf))) {
      throw new AppError('SKW_E_SEC_CSRF', 'missing or wrong csrf token');
    }
  }

  /** The session token from the per-tenant cookie, or `null`. */
  #sessionToken(req: FastifyRequest, tenantKey: string): string | null {
    return cookieValue(header(req, 'cookie'), portalCookieName(tenantKey));
  }

  #view(req: FastifyRequest, tenantKey: string): SelfView | null {
    const token = this.#sessionToken(req, tenantKey);
    return token === null ? null : this.#deps.accounts.authenticate(token, tenantKey, { ip: this.#ip(req) });
  }

  /**
   * One handle per request, closed on the way out — the same discipline `Accounts` keeps. A page
   * reads the profile, the applications and the plugin's adverts through **one** connection, so the
   * three cannot disagree about a snapshot that changed between them.
   */
  #db<T>(tenantKey: string, fn: (db: Database.Database) => T): T {
    const db = this.#deps.openDb(tenantKey);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  /**
   * The site's header and footer for this tenant, or `null` when the tenant has set neither an
   * identity nor a menu.
   *
   * `chromeHtml` is not a second renderer: it is the function the editor's canvas already draws
   * the live shell with, from the same `SiteChrome` and the same `NavTree` that `page.astro` reads
   * for a CMS page. Reusing it is what keeps the portal's header byte-identical to a marketing
   * page's (asserted in `test/portal-presentation.test.ts`) instead of a fourth copy of the bar
   * that drifts the first time someone changes the shell.
   *
   * A read failure renders the page without its header rather than turning the sign-in form into
   * a 500: the portal is the only way into an account, and a broken menu row is not a reason to
   * lock everyone out. The CMS page keeps its own refusal — it has no such duty to a signed-out
   * visitor.
   */
  #chromeParts(tenantKey: string, current?: string): { header: string; footer: string } | null {
    let db: Database.Database | null = null;
    try {
      db = this.#deps.openDb(tenantKey);
      const chrome = loadChrome(db);
      // The same predicate the CMS page hands `loadNav`: a menu entry may name a path a loaded
      // package serves, and refusing it here would drop the whole header on a site that has one.
      const pageExists = this.#deps.pageExists;
      const nav = loadNav(db, pageExists === undefined ? {} : { pageExists: (path) => pageExists(tenantKey, path) });
      return chromeHtml(chrome, nav, chromeLogoUrl(db, chrome), navListHtml, current);
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }

  /**
   * The portal document: the site's chrome around the portal's own column.
   *
   * `/theme.css` is linked first so the tenant's palette, faces and spacing arrive before the
   * portal's rules; `/portal.css` second so a portal rule wins at equal specificity. Both are
   * first-party files because the policy is `style-src 'self'` — there is no inline `<style>` and
   * no third-party request on the page.
   */
  #page(req: FastifyRequest, tenantKey: string, title: string, body: string, width: PortalWidth = 'regular'): string {
    let path = '/portal';
    try {
      path = new URL(req.url, 'http://portal.invalid').pathname;
    } catch {
      path = '/portal';
    }
    // The path first: the chrome marks the current menu entry, and a portal page is as much a
    // page of this site as any other.
    const chrome = this.#chromeParts(tenantKey, path);
    return `<!doctype html>
<html lang="en" data-tenant="${escapeHtml(tenantKey)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/portal.css">
</head>
<body class="portal" data-page-path="${escapeHtml(path)}">
${chrome === null ? '' : chrome.header}
<main class="portal-main">
<div class="${WIDTH_CLASS[width]}">
${body}
</div>
</main>
${chrome === null ? '' : chrome.footer}
</body></html>`;
  }

  /**
   * The CSRF half of the discipline, on a POST: the session's own secret must come back in the body
   * or the header. `null` (no live session) is the same refusal as a wrong token — a caller with a
   * dead cookie learns nothing from the difference.
   */
  #assertSessionCsrf(req: FastifyRequest, tenantKey: string): void {
    const csrf = this.#csrf(req, tenantKey);
    this.#assertCsrf(req, csrf === '' ? null : csrf);
  }

  /** The session's own CSRF secret, for a form about to be rendered. `''` when it is not live. */
  #csrf(req: FastifyRequest, tenantKey: string): string {
    const token = this.#sessionToken(req, tenantKey);
    if (token === null) return '';
    return this.#deps.accounts.csrfFor(token, tenantKey, { ip: this.#ip(req) }) ?? '';
  }

  /**
   * The role gate on a POST: a JSON refusal that names the role the form is for.
   *
   * Roles are additive — one person may be both — so this is `includes`, not `equals`: an account
   * that advertises and also applies gets both pages, and neither gets a refusal.
   */
  #assertRole(view: SelfView, role: Role): void {
    if (!view.roles.includes(role)) {
      throw new AppError('SKW_E_SEC_FORBIDDEN', `this page is for ${role} accounts; this account is not one`);
    }
  }

  /**
   * The applicant gate on **applying**, which is narrower than "signed in" and has its own sentence.
   *
   * An advertiser account is refused by name: `applicant role required`. A person holding both roles
   * passes, because an account that advertises and also applies is exactly the account the additive
   * role model exists for.
   */
  #assertApplicantRole(view: SelfView): void {
    if (!view.roles.includes('applicant')) {
      throw new AppError('SKW_E_SEC_FORBIDDEN', 'applicant role required — this account cannot apply for a role');
    }
  }

  /**
   * The same refusal as a page, for a GET. A 403 with JSON would be correct and useless: whoever
   * followed the link is told which account type the page belongs to, and where to go next.
   */
  #refuseApplicantForApply(req: FastifyRequest, reply: FastifyReply, tenantKey: string, view: SelfView): void {
    const mine = view.roles.length === 0 ? 'no account type' : view.roles.map((r) => escapeHtml(r)).join(', ');
    reply
      .code(403)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        this.#page(
          req,
          tenantKey,
          'Applicant role required',
          `<div class="portal-intro">
  <p class="portal-eyebrow">Applicant only</p>
  <h1>Applicant role required</h1>
  <p class="portal-lede">You are signed in as <strong>${escapeHtml(view.displayName)}</strong>, and your account is: ${mine}.</p>
</div>
<div class="portal-panel">
  <p>An applicant role is required to apply for a role. An advertiser account advertises its own roles; it does not apply to other companies'.</p>
  <p class="portal-aside"><a href="/portal/advertiser">Your roles</a> · <a href="/jobs">The board</a></p>
</div>`,
          'auth',
        ),
      );
  }

  /** The advert behind a `/jobs/<ref>` path — an id or a slug, published only. `null` is a 404. */
  #publishedAdvert(tenantKey: string, ref: string): PublicAdvert | null {
    const id = numericId(ref);
    return this.#db(tenantKey, (db) => {
      const reader = advertReader(db, tenantKey, this.#deps.emailMode);
      return id === null ? reader.publishedBySlug(ref) : reader.published(id);
    });
  }

  /** One application, through the one function that writes them. */
  #apply(db: Database.Database, tenantKey: string, accountId: number, jobId: number, note: string): ApplyOutcome {
    return applyForJob(
      { db, tenant: tenantKey, emailMode: this.#deps.emailMode },
      { applicantAccountId: accountId, jobId, coverNote: note === '' ? null : note },
    );
  }

  /** The confirmation page, at whatever status the refusal or the read earned. */
  #sendApplyPage(
    req: FastifyRequest,
    reply: FastifyReply,
    tenantKey: string,
    advert: PublicAdvert,
    state: { readonly status: number; readonly problem: string | null; readonly note: string },
  ): void {
    reply
      .code(state.status)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        this.#page(
          req,
          tenantKey,
          `Apply — ${advert.title}`,
          applyPageBody({ advert, csrf: this.#csrf(req, tenantKey), note: state.note, problem: state.problem }),
        ),
      );
  }

  /**
   * The role gate on a GET, as a page a person can read. A 403 with JSON would be correct and
   * useless: whoever followed the link is told which account type the page belongs to, and where to
   * go next. The status is still 403, so nothing downstream treats it as a page.
   */
  #refuseRole(req: FastifyRequest, reply: FastifyReply, tenantKey: string, view: SelfView, role: Role): void {
    const mine = view.roles.length === 0 ? 'no account type' : view.roles.map((r) => escapeHtml(r)).join(', ');
    reply
      .code(403)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        this.#page(
          req,
          tenantKey,
          `This page is for ${role} accounts`,
          `<div class="portal-intro">
  <p class="portal-eyebrow">${escapeHtml(role)} only</p>
  <h1>This page is for ${role} accounts</h1>
  <p class="portal-lede">You are signed in as <strong>${escapeHtml(view.displayName)}</strong>, and your account is: ${mine}.</p>
</div>
<p class="portal-aside"><a href="/portal">Back to your account</a></p>`,
          'auth',
        ),
      );
  }

  #setSession(reply: FastifyReply, tenantKey: string, session: { id: string; expiresAt: number }): void {
    const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    reply.header(
      'set-cookie',
      `${portalCookieName(tenantKey)}=${session.id}; ${cookieAttrs(PORTAL_COOKIE_PATH)}; Max-Age=${maxAge}`,
    );
  }

  #clearSession(reply: FastifyReply, tenantKey: string): void {
    reply.header('set-cookie', `${portalCookieName(tenantKey)}=; ${cookieAttrs(PORTAL_COOKIE_PATH)}; Max-Age=0`);
  }

  #enrolSignature(accountId: number): string {
    return createHmac('sha256', this.#deps.env.sessionKey)
      .update(`enrol:${accountId}`)
      .digest('base64url');
  }

  #setEnrol(reply: FastifyReply, tenantKey: string, accountId: number): void {
    const value = `${accountId}.${this.#enrolSignature(accountId)}`;
    reply.header(
      'set-cookie',
      `${enrolCookieName(tenantKey)}=${value}; ${cookieAttrs(PORTAL_COOKIE_PATH)}; Max-Age=${ENROL_TTL_S}`,
    );
  }

  #enrolAccount(req: FastifyRequest, tenantKey: string): number | null {
    const raw = cookieValue(header(req, 'cookie'), enrolCookieName(tenantKey));
    if (raw === null) return null;
    const dot = raw.indexOf('.');
    if (dot <= 0) return null;
    const id = Number(raw.slice(0, dot));
    const signature = raw.slice(dot + 1);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const expected = this.#enrolSignature(id);
    if (signature.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    return id;
  }

  register(app: FastifyInstance): void {
    /**
     * `GET /portal.css` — the portal's own stylesheet, first-party so the policy allows it.
     *
     * The Host is resolved even though the bytes are the same for every tenant: a request to a
     * host this instance does not serve gets the same refusal it gets for any other path, rather
     * than a 200 that says "there is a site here". The sheet names no tenant and carries no data;
     * a day is a fine cache life for a file that changes only when the image does.
     */
    app.get('/portal.css', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#tenant(req);
      reply
        .header('cache-control', 'public, max-age=86400')
        .type('text/css; charset=utf-8')
        .send(PORTAL_CSS);
    });

    app.get('/portal', async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      const token = this.#sessionToken(req, tenantKey) ?? '';
      const csrf = this.#deps.accounts.csrfFor(token, tenantKey, { ip: this.#ip(req) }) ?? '';
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          this.#page(
            req,
            tenantKey,
            'Your account',
            `<div class="portal-intro">
  <p class="portal-eyebrow">Your account</p>
  <h1>Your account</h1>
  <p class="portal-lede">Signed in as <strong>${escapeHtml(view.email)}</strong>.</p>
</div>
<div class="portal-panel">
  <p>Account type: ${view.roles.length === 0 ? '<span class="portal-role">none</span>' : view.roles.map((r) => `<span class="portal-role">${escapeHtml(r)}</span>`).join(' ')}</p>
  <ul class="portal-links">
${view.roles.includes('applicant') ? '    <li><a href="/portal/applicant">Your applications and profile</a></li>\n' : ''}${view.roles.includes('advertiser') ? '    <li><a href="/portal/advertiser">Your company and adverts</a></li>\n' : ''}  </ul>
</div>
<form class="portal-signout" method="post" action="/portal/signout">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <div class="portal-actions"><button class="portal-button portal-button--quiet" type="submit">Sign out</button></div>
</form>`,
          ),
        );
    });

    // --- S9/v9: the applicant's page and the writes behind it -----------------------------------
    // No session is a redirect, not a refusal: a person who bookmarked the page while signed in
    // should land on the sign-in form, not on an error. A session without the role is a refusal
    // that names it — the two answers are different and the difference is the person's.
    app.get('/portal/applicant', async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin?next=%2Fportal%2Fapplicant').send();
        return;
      }
      if (!view.roles.includes('applicant')) {
        this.#refuseRole(req, reply, tenantKey, view, 'applicant');
        return;
      }
      const csrf = this.#csrf(req, tenantKey);
      const appliedId = numericId((req.query as { applied?: unknown }).applied);
      const data = this.#db(tenantKey, (db) => ({
        profile: loadProfile(db, view.accountId),
        applications: applicationsForApplicant(
          { db, tenant: tenantKey, emailMode: this.#deps.emailMode },
          view.accountId,
        ),
        appliedTitle: appliedId === null ? null : advertReader(db, tenantKey, this.#deps.emailMode).job(appliedId)?.title ?? null,
      }));
      if (data.profile === null) {
        // Registration writes the profile, so this is a half-created account rather than a normal
        // state. It is refused by name instead of rendered as a page of empty fields that the next
        // POST would then fail to update.
        reply
          .code(404)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(
            this.#page(
              req,
              tenantKey,
              'No profile yet',
              `<div class="portal-intro">
  <p class="portal-eyebrow">Applicant</p>
  <h1>No profile yet</h1>
</div>
<div class="portal-panel">
  <p>This account has no profile row, so there is nothing to show or edit. Ask the site operator to finish the account.</p>
  <p class="portal-aside"><a href="/portal">Back to your account</a></p>
</div>`,
              'auth',
            ),
          );
        return;
      }
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          this.#page(
            req,
            tenantKey,
            'Your applications',
            applicantPage(data.profile, data.applications, csrf, {
              alsoAdvertises: view.roles.includes('advertiser'),
              flash: appliedFlash(appliedId, data.appliedTitle),
            }),
            'wide',
          ),
        );
    });

    app.post('/portal/applicant/profile', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      this.#assertSessionCsrf(req, tenantKey);
      this.#assertRole(view, 'applicant');
      const parsed = profileEditFrom(fieldsOf(req.body));
      if (parsed.ok === false) throw new AppError('SKW_E_PLT_REQUEST_INVALID', parsed.problem);
      const changed = this.#db(tenantKey, (db) => saveProfile(db, view.accountId, parsed.edit, Date.now()));
      if (changed !== 1) throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'this account has no profile to save');
      // Post/redirect/get: a reload after saving must not re-save, and the page shows the new row.
      reply.code(303).header('location', '/portal/applicant').send();
    });

    /**
     * `POST /portal/applicant/apply` — the advert's id in a body, for a client that already holds
     * one. The page no longer offers this form (applying starts on the role, `/jobs/<id>/apply`),
     * but the write path stays: it is the same act, through the same function, with the same named
     * refusals, and a bookmark or a script from before the change keeps working.
     */
    app.post('/portal/applicant/apply', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      this.#assertSessionCsrf(req, tenantKey);
      this.#assertApplicantRole(view);
      const fields = fieldsOf(req.body);
      const jobId = optionalInt(field(fields, 'job_id'), 'The advert number');
      if (jobId.ok === false) throw new AppError('SKW_E_PLT_REQUEST_INVALID', jobId.problem);
      if (jobId.value === null) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'An advert number is required.');
      const note = field(fields, 'cover_note').trim();
      const refusedNote = coverNoteRefusal(note);
      if (refusedNote !== null) throw new AppError('SKW_E_PLT_REQUEST_INVALID', refusedNote);
      const outcome = this.#db(tenantKey, (db) => this.#apply(db, tenantKey, view.accountId, jobId.value as number, note));
      if (outcome.ok === false) throw applyRefusal(outcome);
      reply.code(303).header('location', `/portal/applicant?applied=${String(jobId.value as number)}`).send();
    });

    /**
     * `POST /portal/applicant/withdraw` — the applicant takes their own application back.
     *
     * The same three gates as every other portal write: origin, the session's CSRF, the role. The
     * answer is a redirect either way, so a second click (or a reloaded POST) is not an error page:
     * `withdrawApplication` is idempotent, and the row it already ended is still ended.
     */
    app.post('/portal/applicant/withdraw', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      this.#assertSessionCsrf(req, tenantKey);
      this.#assertApplicantRole(view);
      const applicationId = optionalInt(field(fieldsOf(req.body), 'application_id'), 'The application number');
      if (applicationId.ok === false) throw new AppError('SKW_E_PLT_REQUEST_INVALID', applicationId.problem);
      if (applicationId.value === null) {
        throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'An application number is required.');
      }
      const outcome = this.#db(tenantKey, (db) =>
        withdrawApplication(
          { db, tenant: tenantKey, emailMode: this.#deps.emailMode },
          { applicationId: applicationId.value as number, applicantAccountId: view.accountId },
        ),
      );
      if (outcome.ok === false) throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such application for this account');
      reply.code(303).header('location', '/portal/applicant').send();
    });

    // --- v10: applying starts on the role -------------------------------------------------------
    //
    // `/jobs/<id>/apply` is the advert's own application page. It lives here, in the portal, and
    // not in the public board's renderer, because everything it does needs a session: the CSRF
    // token it carries, the account it names on the row, and the profile the policy checks before
    // a stranger's name is disclosed. The public page's button is a plain link to this path; a
    // signed-out visitor is sent to the sign-in form with this page as `next`, and comes back to
    // it — the advert comes with them, so there is no id to copy.
    // The session cookie is scoped to Path=/portal, deliberately: a job page is public and must
    // not receive a credential. So the apply flow lives under /portal, where the cookie is sent —
    // otherwise a signed-in applicant arrives at /jobs/<id>/apply with no session and is asked to
    // sign in again. `/jobs/<id>/apply` stays as a 303 to here so old links keep working.
    app.get('/jobs/:ref/apply', async (req: FastifyRequest, reply: FastifyReply) => {
      const ref = String((req.params as { ref?: string }).ref ?? '');
      reply.code(303).header('location', `/portal/jobs/${encodeURIComponent(ref)}/apply`).send();
    });

    app.get('/portal/jobs/:ref/apply', async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantKey = this.#tenant(req);
      const ref = String((req.params as { ref?: string }).ref ?? '');
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', `/portal/signin?next=${encodeURIComponent(`/portal/jobs/${ref}/apply`)}`).send();
        return;
      }
      if (!view.roles.includes('applicant')) {
        this.#refuseApplicantForApply(req, reply, tenantKey, view);
        return;
      }
      const advert = this.#publishedAdvert(tenantKey, ref);
      if (advert === null) throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'that advert is not on this board');
      this.#sendApplyPage(req, reply, tenantKey, advert, { status: 200, problem: null, note: '' });
    });

    app.post('/jobs/:ref/apply', async (req: FastifyRequest, reply: FastifyReply) => {
      const ref = String((req.params as { ref?: string }).ref ?? '');
      reply.code(307).header('location', `/portal/jobs/${encodeURIComponent(ref)}/apply`).send();
    });

    app.post('/portal/jobs/:ref/apply', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const ref = String((req.params as { ref?: string }).ref ?? '');
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', `/portal/signin?next=${encodeURIComponent(`/portal/jobs/${ref}/apply`)}`).send();
        return;
      }
      this.#assertSessionCsrf(req, tenantKey);
      this.#assertApplicantRole(view);
      const advert = this.#publishedAdvert(tenantKey, ref);
      if (advert === null) throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'that advert is not on this board');
      const note = field(fieldsOf(req.body), 'cover_note').trim();
      // A cover note is free text a stranger wrote, so it is screened before it can reach a row:
      // the advertiser never receives an address through this door either.
      const refusedNote = coverNoteRefusal(note);
      if (refusedNote !== null) {
        this.#sendApplyPage(req, reply, tenantKey, advert, { status: 400, problem: refusedNote, note });
        return;
      }
      const outcome = this.#db(tenantKey, (db) => this.#apply(db, tenantKey, view.accountId, advert.id, note));
      if (outcome.ok === false) {
        // The refusal is a page, not a stack of JSON: the person is standing on the confirmation
        // form, and the sentence tells them whether to fix something or stop. `duplicate` is a 409
        // and says which application it means; no constraint name is ever printed.
        const error = applyRefusal(outcome);
        this.#sendApplyPage(req, reply, tenantKey, advert, {
          status: HTTP[error.code] ?? 400,
          problem: `${error.message}. Nothing was sent.`,
          note,
        });
        return;
      }
      reply.code(303).header('location', `/portal/applicant?applied=${String(advert.id)}`).send();
    });

    // --- S9/v9: the advertiser's page -----------------------------------------------------------
    app.get('/portal/advertiser', async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin?next=%2Fportal%2Fadvertiser').send();
        return;
      }
      if (!view.roles.includes('advertiser')) {
        this.#refuseRole(req, reply, tenantKey, view, 'advertiser');
        return;
      }
      const csrf = this.#csrf(req, tenantKey);
      const applications = this.#db(tenantKey, (db) =>
        applicationsForAdvertiser({ db, tenant: tenantKey, emailMode: this.#deps.emailMode }, view.accountId),
      );
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          this.#page(
            req,
            tenantKey,
            'Applications to your roles',
            advertiserPage(view.displayName, applications, csrf, { alsoApplies: view.roles.includes('applicant') }),
            'wide',
          ),
        );
    });

    app.post('/portal/advertiser/application', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      this.#assertSessionCsrf(req, tenantKey);
      this.#assertRole(view, 'advertiser');
      const fields = fieldsOf(req.body);
      const applicationId = optionalInt(field(fields, 'application_id'), 'The application number');
      if (applicationId.ok === false) throw new AppError('SKW_E_PLT_REQUEST_INVALID', applicationId.problem);
      if (applicationId.value === null) {
        throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'An application number is required.');
      }
      const status = field(fields, 'status');
      // The closed vocabulary, checked before it reaches the column's CHECK. `submitted` is the
      // applicant's state and `withdrawn` is theirs to keep; an advertiser may only decide.
      if (!(ADVERTISER_STATUSES as readonly string[]).includes(status)) {
        throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'A decision is shortlisted or rejected.');
      }
      const outcome = this.#db(tenantKey, (db) =>
        setApplicationStatus(
          { db, tenant: tenantKey, emailMode: this.#deps.emailMode },
          {
            applicationId: applicationId.value as number,
            advertiserAccountId: view.accountId,
            status: status as AdvertiserStatus,
          },
        ),
      );
      if (outcome.ok === false) {
        throw outcome.reason === 'not_found'
          ? new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such application for this account')
          : new AppError('SKW_E_PLT_REQUEST_INVALID', 'the applicant withdrew this application; it cannot be reopened');
      }
      reply.code(303).header('location', '/portal/advertiser').send();
    });

    /**
     * `POST /portal/advertiser/outcome` — the company records what it concluded about one application.
     *
     * The same three gates as every other portal write — origin, the session's CSRF, the advertiser
     * role — and then `recordOutcome`, which scopes the row to this account in its read *and* its
     * write, refuses a withdrawn row by name, and screens the note before it can reach the column.
     *
     * **It does not touch `status`.** An outcome is an advisory record stored beside the applicant's
     * lifecycle; the decision buttons above are a different write with a different meaning, and this
     * route has no way to become that one.
     */
    app.post('/portal/advertiser/outcome', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      this.#assertSessionCsrf(req, tenantKey);
      this.#assertRole(view, 'advertiser');
      const fields = fieldsOf(req.body);
      const applicationId = optionalInt(field(fields, 'application_id'), 'The application number');
      if (applicationId.ok === false) throw new AppError('SKW_E_PLT_REQUEST_INVALID', applicationId.problem);
      if (applicationId.value === null) {
        throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'An application number is required.');
      }
      // The note is screened inside `recordOutcome`: the function that writes the column is the
      // function that enforces what may be in it, so a second caller cannot forget.
      const result = this.#db(tenantKey, (db) =>
        recordOutcome(
          { db, tenant: tenantKey, emailMode: this.#deps.emailMode },
          {
            applicationId: applicationId.value as number,
            advertiserAccountId: view.accountId,
            outcome: field(fields, 'outcome'),
            note: field(fields, 'outcome_note'),
          },
        ),
      );
      if (result.ok === false) throw outcomeRefusal(result.reason);
      reply.code(303).header('location', '/portal/advertiser').send();
    });

    app.get('/portal/register', async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantKey = this.#tenant(req);
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          this.#page(
            req,
            tenantKey,
            'Create an account',
            `<div class="portal-intro">
  <p class="portal-eyebrow">New account</p>
  <h1>Create an account</h1>
  <p class="portal-lede">One account for both sides of the board: find fractional work, advertise a role, or both.</p>
</div>
<form class="portal-form portal-card" method="post" action="/portal/register">
  <div class="portal-field">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required>
  </div>
  <div class="portal-field">
    <label for="display">Name shown on your profile</label>
    <input id="display" name="display_name" autocomplete="name" maxlength="120" required>
  </div>
  <div class="portal-field">
    <label for="password">Password (at least ${PASSWORD_MIN} characters)</label>
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" required>
  </div>
  <fieldset class="portal-fieldset">
    <legend>What do you want to do?</legend>
    <label class="portal-check"><input type="checkbox" name="role" value="applicant"> Find fractional work</label>
    <label class="portal-check"><input type="checkbox" name="role" value="advertiser"> Advertise a role</label>
  </fieldset>
  <div class="portal-actions"><button class="portal-button" type="submit">Create account</button></div>
</form>
<p class="portal-aside">Already have one? <a href="/portal/signin">Sign in</a>.</p>`,
            'auth',
          ),
        );
    });

    app.post('/portal/register', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const fields = fieldsOf(req.body);
      const email = field(fields, 'email');
      const password = field(fields, 'password');
      const displayName = field(fields, 'display_name').trim();
      const roles = (fields.role ?? []).filter((r): r is Role => r === 'applicant' || r === 'advertiser');

      const result = await this.#deps.accounts.register(
        { email, password, displayName, roles },
        tenantKey,
        { ip: this.#ip(req) },
      );

      if (result.kind === 'exists') {
        reply
          .code(200)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(
            this.#page(
              req,
              tenantKey,
              'Check your email',
              `<div class="portal-intro">
  <p class="portal-eyebrow">New account</p>
  <h1>That address already has an account</h1>
</div>
<div class="portal-panel">
  <p>We have emailed ${escapeHtml(email)} a reminder of how to get in. If it does not arrive, sign in and use “forgot password”.</p>
  <div class="portal-actions"><a class="portal-button portal-button--quiet" href="/portal/signin">Sign in</a></div>
</div>`,
              'auth',
            ),
          );
        return;
      }

      // The secret is shown exactly once, here. There is no second chance to see it, and the
      // account cannot become active until a code from it has been entered.
      // What the customer reads: the link goes to their inbox, and the account stays shut until
      // they act on it. The URL is deliberately not printed on the page — a page that shows it
      // turns "prove you own that address" into "click this". The one exception is a box with no
      // mail transport, where printing it is the only way to finish a local sign-up, and the
      // block says so in as many words.
      const checkEmail =
        '<p>We have sent a confirmation link to the address you gave us. <strong>Check your email</strong> and open that link — you will not be able to log in until your email address is confirmed.</p>';
      const link =
        result.verifyUrl === undefined
          ? checkEmail
          : `${checkEmail}
  <p class="portal-note portal-note--dev">Development only: this box has no mail transport configured, so here is the link that would have been emailed — <a href="${escapeHtml(result.verifyUrl)}">${escapeHtml(result.verifyUrl)}</a></p>`;
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          this.#page(
            req,
            tenantKey,
            'Set up your authenticator',
            `<div class="portal-intro">
  <p class="portal-eyebrow">Two-factor</p>
  <h1>Set up your authenticator</h1>
  <p class="portal-lede">Add this account to an authenticator app (1Password, Authy, Google Authenticator). Type the key in by hand if you cannot scan.</p>
</div>
<div class="portal-panel">
  <p class="portal-totp"><code>${escapeHtml(result.totpGrouped)}</code></p>
  <p><a href="${escapeHtml(result.otpauthUri)}">Open in your authenticator app</a></p>
  ${link}
  <p class="portal-note">Your account stays inactive until you have confirmed the email and entered a code from the app.</p>
</div>`,
            'auth',
          ),
        );
    });

    app.get('/portal/verify', async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantKey = this.#tenant(req);
      const token = String((req.query as { token?: unknown }).token ?? '');
      const outcome = token === '' ? ({ ok: false, reason: 'unknown' } as const) : this.#deps.accounts.verifyEmail(token, tenantKey);
      if (outcome.ok === false) {
        const why =
          outcome.reason === 'expired'
            ? 'That link has expired. Sign in and ask for a new one.'
            : outcome.reason === 'consumed'
              ? 'That link has already been used.'
              : 'That link is not valid.';
        reply
          .code(400)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(
            this.#page(
              req,
              tenantKey,
              'Link not valid',
              `<div class="portal-intro">
  <p class="portal-eyebrow">Email confirmation</p>
  <h1>Link not valid</h1>
</div>
<div class="portal-panel">
  <p class="portal-banner portal-banner--error">${escapeHtml(why)}</p>
  <p class="portal-aside"><a href="/portal/signin">Sign in</a> and ask for a new link.</p>
</div>`,
              'auth',
            ),
          );
        return;
      }
      if (outcome.next === 'active') {
        this.#clearEnrol(reply, tenantKey);
        reply
          .code(200)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(
            this.#page(
              req,
              tenantKey,
              'Address confirmed',
              `<div class="portal-intro">
  <p class="portal-eyebrow">Email confirmation</p>
  <h1>Address confirmed</h1>
</div>
<div class="portal-panel">
  <p class="portal-banner portal-banner--success">Your email address is confirmed. Sign in to continue.</p>
  <div class="portal-actions"><a class="portal-button" href="/portal/signin">Sign in</a></div>
</div>`,
              'auth',
            ),
          );
        return;
      }
      // Address proved, TOTP still owed: the person is not signed in, and the enrolment cookie is
      // what lets them submit the code without pretending to be.
      this.#setEnrol(reply, tenantKey, outcome.accountId);
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          this.#page(
            req,
            tenantKey,
            'Enter a code',
            `<div class="portal-intro">
  <p class="portal-eyebrow">Two-factor</p>
  <h1>One more step</h1>
  <p class="portal-lede">Enter the six-digit code from your authenticator app.</p>
</div>
<form class="portal-form portal-card" method="post" action="/portal/enrol">
  <div class="portal-field">
    <label for="code">Code</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
    <p class="portal-hint">Six digits, and they change every thirty seconds.</p>
  </div>
  <div class="portal-actions"><button class="portal-button" type="submit">Confirm</button></div>
</form>`,
            'auth',
          ),
        );
    });

    app.post('/portal/enrol', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const accountId = this.#enrolAccount(req, tenantKey);
      if (accountId === null) {
        throw new AppError('SKW_E_SEC_TOKEN_INVALID', 'start again from the link in your email');
      }
      const code = field(fieldsOf(req.body), 'code');
      const result = this.#deps.accounts.confirmTotp(accountId, code, tenantKey);
      if (!result.ok) {
        reply
          .code(401)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(
            this.#page(
              req,
              tenantKey,
              'Wrong code',
              `<div class="portal-intro">
  <p class="portal-eyebrow">Two-factor</p>
  <h1>That code is not right</h1>
</div>
<form class="portal-form portal-card" method="post" action="/portal/enrol">
  <div class="portal-field">
    <label for="code">Code</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-invalid="true" required>
    <p class="portal-error" role="alert">Check the six digits in your authenticator app and try again.</p>
  </div>
  <div class="portal-actions"><button class="portal-button" type="submit">Try again</button></div>
</form>`,
              'auth',
            ),
          );
        return;
      }
      this.#clearEnrol(reply, tenantKey);
      reply.code(303).header('location', '/portal/signin').send();
    });

    app.get('/portal/signin', async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantKey = this.#tenant(req);
      // `?next=` rides through the form, so a person who was sent here from a role keeps the role.
      // Only a local path survives `localPath`; anything else is dropped rather than echoed.
      const next = localPath(String((req.query as { next?: unknown }).next ?? ''));
      const view = this.#view(req, tenantKey);
      // Someone already signed in does not need the form: the destination they asked for, or their
      // own portal. This is also what makes a stale "sign in" link in a bookmark harmless.
      if (view !== null) {
        reply.code(303).header('location', next ?? homeFor(view.roles)).send();
        return;
      }
      const carry = next === null ? '' : `\n  <input type="hidden" name="next" value="${escapeHtml(next)}">`;
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          this.#page(
            req,
            tenantKey,
            'Sign in',
            `<div class="portal-intro">
  <p class="portal-eyebrow">Your account</p>
  <h1>Sign in</h1>
  <p class="portal-lede">Your password and the six-digit code from your authenticator app.</p>
</div>
<form class="portal-form portal-card" method="post" action="/portal/signin">${carry}
  <div class="portal-field">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required>
  </div>
  <div class="portal-field">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
  </div>
  <div class="portal-field">
    <label for="code">Authenticator code</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
    <p class="portal-hint">Six digits from the app you set up when you registered.</p>
  </div>
  <div class="portal-actions"><button class="portal-button" type="submit">Sign in</button></div>
</form>
<p class="portal-aside">New here? <a href="/portal/register">Create an account</a>.</p>`,
            'auth',
          ),
        );
    });

    app.post('/portal/signin', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const fields = fieldsOf(req.body);
      // Where this sign-in should land, validated once: a local path survives, anything else is
      // dropped and the account's own portal is used instead.
      const next = localPath(field(fields, 'next'));
      const result = await this.#deps.accounts.signIn(
        { email: field(fields, 'email'), password: field(fields, 'password'), code: field(fields, 'code') },
        tenantKey,
        { ip: this.#ip(req), userAgent: header(req, 'user-agent') ?? '' },
      );
      if (result.ok === false) {
        // One page and one sentence for every refusal. The resend link is the way back for a person
        // who is pending, and it sends only when there is something to send.
        const message =
          result.reason === 'locked'
            ? 'Too many attempts. Wait a few minutes and try again.'
            : 'That email, password or code is not right.';
        reply
          .code(result.reason === 'locked' ? 429 : 401)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(
            this.#page(
              req,
              tenantKey,
              'Sign in',
              `<div class="portal-intro">
  <p class="portal-eyebrow">Your account</p>
  <h1>Sign in</h1>
</div>
<form class="portal-form portal-card" method="post" action="/portal/signin">
  ${next === null ? '' : `<input type="hidden" name="next" value="${escapeHtml(next)}">`}
  <p class="portal-banner portal-banner--error" role="alert">${escapeHtml(message)}</p>
  <div class="portal-field">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required>
  </div>
  <div class="portal-field">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
  </div>
  <div class="portal-field">
    <label for="code">Authenticator code</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
  </div>
  <div class="portal-actions"><button class="portal-button" type="submit">Sign in</button></div>
</form>
<p class="portal-aside">New here? <a href="/portal/register">Create an account</a>.</p>`,
              'auth',
            ),
          );
        return;
      }
      this.#setSession(reply, tenantKey, result.session);
      // Straight to the account's own portal. An explicit same-origin `next` wins over the default,
      // because the person asked for a destination and the role's home is only the fallback.
      reply.code(303).header('location', next ?? homeFor(result.account.roles)).send();
    });

    app.post('/portal/signout', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const token = this.#sessionToken(req, tenantKey);
      if (token === null) {
        this.#clearSession(reply, tenantKey);
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      this.#assertCsrf(req, this.#deps.accounts.csrfFor(token, tenantKey, { ip: this.#ip(req) }));
      this.#deps.accounts.signOut(token, tenantKey);
      this.#clearSession(reply, tenantKey);
      reply.code(303).header('location', '/portal/signin').send();
    });
  }

  #clearEnrol(reply: FastifyReply, tenantKey: string): void {
    reply.header('set-cookie', `${enrolCookieName(tenantKey)}=; ${cookieAttrs(PORTAL_COOKIE_PATH)}; Max-Age=0`);
  }
}

export function registerPortal(app: FastifyInstance, deps: PortalDeps): Portal {
  const portal = new Portal(deps);
  portal.register(app);
  return portal;
}
