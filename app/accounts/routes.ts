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
import { AppError } from '../errors.ts';
import type { Env } from '../env.ts';
import type { Accounts, Role, SelfView } from './service.ts';
import { PASSWORD_MIN } from './service.ts';
import {
  ADVERTISER_STATUSES,
  applicationsForAdvertiser,
  applicationsForApplicant,
  applyForJob,
  setApplicationStatus,
  type AdvertiserApplication,
  type ApplyRefusal,
  type AdvertiserStatus,
  type ApplicantApplication,
} from './applications.ts';
import {
  PROFILE_LIMITS,
  parseVisibility,
  profileEditProblem,
  type ApplicantProfile,
  type ProfileEdit,
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
 * Cents as money, the one way this product writes a rate. `null` is "discussed" — a person who left
 * the field empty has said something, and rendering `0.00` would say the opposite.
 */
function money(cents: number | null, currency: string): string {
  return cents === null ? 'discussed' : `${(cents / 100).toFixed(2)} ${currency} a day`;
}

function days(n: number | null): string {
  return n === null ? 'not stated' : `${n} ${n === 1 ? 'day' : 'days'} a week`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
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
  const rate = optionalInt(field(fields, 'day_rate_cents'), 'The day rate');
  if (rate.ok === false) return rate;
  const availability = optionalInt(field(fields, 'availability_days_per_week'), 'Availability');
  if (availability.ok === false) return availability;
  const headline = field(fields, 'headline').trim();
  const summary = field(fields, 'summary').trim();
  const edit: ProfileEdit = {
    displayName: field(fields, 'display_name'),
    headline: headline === '' ? null : headline,
    summary: summary === '' ? null : summary,
    dayRateCents: rate.value,
    availabilityDaysPerWeek: availability.value,
    remoteOk: truthy(field(fields, 'remote_ok')),
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

/** The page shell. `theme.css` is the site's own stylesheet and is allowed by `style-src 'self'`. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/theme.css">
</head>
<body class="portal">
<main class="portal-main">
${body}
</main>
</body></html>`;
}

/**
 * `GET /portal/applicant` — the applicant's own record and their own rows, on one page.
 *
 * The page is a form and a table. It renders **no** value it did not read from this account's own
 * rows: `cms_profile` for the summary and `cms_application WHERE applicant_account_id = ?` for the
 * list. The CSRF token is the session's, so the two forms below cannot be posted from another
 * origin even with the cookie attached.
 */
function applicantPage(profile: ApplicantProfile, applications: readonly ApplicantApplication[], csrf: string): string {
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

  const rows = applications.length === 0
    ? '<tr><td colspan="3">You have not applied for anything yet.</td></tr>'
    : applications
        .map(
          (row) =>
            `<tr><td>${row.jobTitle === null ? `#${row.jobId}` : `${escapeHtml(row.jobTitle)} <small>#${row.jobId}</small>`}</td>` +
            `<td>${escapeHtml(row.status)}</td><td>${day(row.createdAt)}</td></tr>`,
        )
        .join('\n');

  return `<h1>Your applications</h1>
<p>Signed in as <strong>${escapeHtml(profile.displayName)}</strong>. <a href="/portal">Your account</a></p>

<h2>Your profile</h2>
<p class="note">Advertisers never see your email address, your phone number or any postal address — the board has no column for one. They see the fields below, and only when you apply to their advert or your profile is discoverable.</p>
<dl class="profile">
  <dt>Name</dt><dd>${escapeHtml(profile.displayName)}</dd>
  <dt>Headline</dt><dd>${profile.headline === null ? '—' : escapeHtml(profile.headline)}</dd>
  <dt>Summary</dt><dd>${profile.summary === null ? '—' : escapeHtml(profile.summary)}</dd>
  <dt>Day rate</dt><dd>${money(profile.dayRateCents, profile.currency)}</dd>
  <dt>Availability</dt><dd>${days(profile.availabilityDaysPerWeek)}</dd>
  <dt>Remote</dt><dd>${yesNo(profile.remoteOk)}</dd>
  <dt>Discoverability</dt><dd>${escapeHtml(profile.visibility)}</dd>
  <dt>Emailed about new roles</dt><dd>${yesNo(profile.notifyNewJobs)}</dd>
  <dt>Skills</dt><dd><ul>${skills}</ul></dd>
  <dt>Links</dt><dd><ul>${links}</ul></dd>
</dl>

<h2>Edit your profile</h2>
<form method="post" action="/portal/applicant/profile">
  ${csrfField(csrf)}
  <p><label for="display_name">Name shown on your profile</label>
     <input id="display_name" name="display_name" value="${escapeHtml(profile.displayName)}" maxlength="${PROFILE_LIMITS.displayName}" required></p>
  <p><label for="headline">Headline</label>
     <input id="headline" name="headline" value="${escapeHtml(profile.headline ?? '')}" maxlength="${PROFILE_LIMITS.headline}"></p>
  <p><label for="summary">Summary</label>
     <textarea id="summary" name="summary" rows="6" maxlength="${PROFILE_LIMITS.summary}">${escapeHtml(profile.summary ?? '')}</textarea></p>
  <p><label for="day_rate_cents">Day rate in cents (leave empty for “discussed”)</label>
     <input id="day_rate_cents" name="day_rate_cents" type="number" min="1" step="1" value="${profile.dayRateCents === null ? '' : String(profile.dayRateCents)}"></p>
  <p><label for="availability_days_per_week">Days a week you are available</label>
     <input id="availability_days_per_week" name="availability_days_per_week" type="number" min="1" max="7" step="1" value="${profile.availabilityDaysPerWeek === null ? '' : String(profile.availabilityDaysPerWeek)}"></p>
  <p><label for="remote_ok">Work remotely</label>
     <select id="remote_ok" name="remote_ok">
       <option value="1"${selected(profile.remoteOk)}>yes</option>
       <option value="0"${selected(!profile.remoteOk)}>no</option>
     </select></p>
  <p><label for="visibility">Discoverability</label>
     <select id="visibility" name="visibility">
       <option value="discoverable"${selected(profile.visibility === 'discoverable')}>discoverable — my profile may be matched against new roles</option>
       <option value="hidden"${selected(profile.visibility === 'hidden')}>hidden — not matched, and I cannot apply</option>
     </select></p>
  <p><label for="notify_new_jobs">Email me when a matching role is posted</label>
     <select id="notify_new_jobs" name="notify_new_jobs">
       <option value="1"${selected(profile.notifyNewJobs)}>yes</option>
       <option value="0"${selected(!profile.notifyNewJobs)}>no</option>
     </select></p>
  <button type="submit">Save profile</button>
</form>

<h2>Your applications</h2>
<table class="applications">
  <thead><tr><th>Role</th><th>State</th><th>Sent</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

<h2>Apply for a role</h2>
<p class="note">Enter the advert's number. It is the <code>id</code> of the role on this board — an application names the advert, and the board resolves the advertiser from it, so there is nothing here to type about who should receive it.</p>
<form method="post" action="/portal/applicant/apply">
  ${csrfField(csrf)}
  <p><label for="job_id">Advert number</label>
     <input id="job_id" name="job_id" type="number" min="1" step="1" required></p>
  <p><label for="cover_note">What you would bring to it</label>
     <textarea id="cover_note" name="cover_note" rows="6" maxlength="${PROFILE_LIMITS.coverNote}"></textarea></p>
  <button type="submit">Send application</button>
</form>`;
}

/**
 * `GET /portal/advertiser` — the applications to this advertiser's own adverts.
 *
 * Every applicant cell is a `ProfileProjection`, which has no email, no phone and no address field
 * at all. The name and the rate below are the applicant's own choices; the “why you can see this”
 * line is the projection's `basis`, rendered as a note rather than as data. A row whose profile is
 * unavailable shows the application and no person: the board does not fall back to the account.
 */
function advertiserPage(displayName: string, applications: readonly AdvertiserApplication[], csrf: string): string {
  const rows = applications.length === 0
    ? '<tr><td colspan="5">No applications yet. When someone applies to one of your roles it appears here.</td></tr>'
    : applications
        .map((row) => {
          const profile = row.profile;
          // The note says *why* this viewer may see the profile, and it is read off the projection
          // (`basis`) rather than asserted here: if the policy ever answers an advertiser for a
          // different reason, this line follows it instead of lying about it.
          const who = profile === null
            ? '<span class="note">This applicant\'s profile is not available.</span>'
            : `<strong>${escapeHtml(profile.displayName)}</strong>` +
              (profile.headline === null ? '' : `<div>${escapeHtml(profile.headline)}</div>`) +
              (profile.summary === null ? '' : `<div class="summary">${escapeHtml(profile.summary)}</div>`) +
              `<div>${money(profile.dayRateCents, profile.currency)} · ${days(profile.availabilityDaysPerWeek)} · remote: ${yesNo(profile.remoteOk)}</div>` +
              (profile.location === null ? '' : `<div>${escapeHtml(profile.location)}</div>`) +
              (profile.skills.length === 0 ? '' : `<div>skills: ${profile.skills.map((s) => escapeHtml(s)).join(', ')}</div>`) +
              // A link is a string the applicant typed: rendered as text, never as an `href`.
              (profile.links.length === 0
                ? ''
                : `<div>links: ${profile.links.map((l) => `${escapeHtml(l.label)} — ${escapeHtml(l.url)}`).join('; ')}</div>`) +
              `<div class="basis">${escapeHtml(
                profile.basis === 'application' ? 'visible because they applied to this role' : `visible as ${profile.basis}`,
              )}</div>`;
          const note = row.coverNote === null ? '<span class="note">no note</span>' : escapeHtml(row.coverNote);
          const decision = row.status === 'withdrawn'
            ? '<span class="note">withdrawn by the applicant</span>'
            : `<form method="post" action="/portal/advertiser/application">
                 <input type="hidden" name="application_id" value="${row.id}">
                 ${csrfField(csrf)}
                 <button type="submit" name="status" value="shortlisted">Shortlist</button>
                 <button type="submit" name="status" value="rejected">Reject</button>
               </form>`;
          return `<tr><td>${row.jobTitle === null ? `#${row.jobId}` : `${escapeHtml(row.jobTitle)} <small>#${row.jobId}</small>`}</td>` +
            `<td>${who}</td><td>${note}</td><td>${day(row.createdAt)}<div class="state">${escapeHtml(row.status)}</div></td><td>${decision}</td></tr>`;
        })
        .join('\n');

  return `<h1>Applications to your roles</h1>
<p>Signed in as <strong>${escapeHtml(displayName)}</strong>. <a href="/portal">Your account</a></p>
<p class="note">Applicants are shown as they chose to be seen. The board never sends you an email address, a phone number or a postal address, and there is no field on this page that could carry one.</p>
<table class="applications">
  <thead><tr><th>Role</th><th>Applicant</th><th>What they said</th><th>Received</th><th>Decision</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
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
   * The role gate on a GET, as a page a person can read. A 403 with JSON would be correct and
   * useless: whoever followed the link is told which account type the page belongs to, and where to
   * go next. The status is still 403, so nothing downstream treats it as a page.
   */
  #refuseRole(reply: FastifyReply, view: SelfView, role: Role): void {
    const mine = view.roles.length === 0 ? 'no account type' : view.roles.map((r) => escapeHtml(r)).join(', ');
    reply
      .code(403)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        page(
          `This page is for ${role} accounts`,
          `<h1>This page is for ${role} accounts</h1>
<p>You are signed in as <strong>${escapeHtml(view.displayName)}</strong>, and your account is: ${mine}.</p>
<p><a href="/portal">Back to your account</a></p>`,
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
          page(
            'Your account',
            `<h1>Your account</h1>
<p>Signed in as <strong>${escapeHtml(view.email)}</strong>.</p>
<p>Account type: ${view.roles.map((r) => `<span class="role">${escapeHtml(r)}</span>`).join(', ')}</p>
${view.roles.includes('applicant') ? '<p><a href="/portal/applicant">Your applications and profile</a></p>' : ''}
${view.roles.includes('advertiser') ? '<p><a href="/portal/advertiser">Your company and adverts</a></p>' : ''}
<form method="post" action="/portal/signout">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <button type="submit">Sign out</button>
</form>`,
          ),
        );
    });

    // --- S9/v9: the applicant's page and the two writes behind it -------------------------------
    // No session is a redirect, not a refusal: a person who bookmarked the page while signed in
    // should land on the sign-in form, not on an error. A session without the role is a refusal
    // that names it — the two answers are different and the difference is the person's.
    app.get('/portal/applicant', async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      if (!view.roles.includes('applicant')) {
        this.#refuseRole(reply, view, 'applicant');
        return;
      }
      const csrf = this.#csrf(req, tenantKey);
      const data = this.#db(tenantKey, (db) => ({
        profile: loadProfile(db, view.accountId),
        applications: applicationsForApplicant(
          { db, tenant: tenantKey, emailMode: this.#deps.emailMode },
          view.accountId,
        ),
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
            page(
              'No profile yet',
              `<h1>No profile yet</h1>
<p>This account has no profile row, so there is nothing to show or edit. Ask the site operator to finish the account.</p>`,
            ),
          );
        return;
      }
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(page('Your applications', applicantPage(data.profile, data.applications, csrf)));
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

    app.post('/portal/applicant/apply', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      this.#assertSessionCsrf(req, tenantKey);
      this.#assertRole(view, 'applicant');
      const fields = fieldsOf(req.body);
      const jobId = optionalInt(field(fields, 'job_id'), 'The advert number');
      if (jobId.ok === false) throw new AppError('SKW_E_PLT_REQUEST_INVALID', jobId.problem);
      if (jobId.value === null) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'An advert number is required.');
      const note = field(fields, 'cover_note').trim();
      const outcome = this.#db(tenantKey, (db) =>
        applyForJob(
          { db, tenant: tenantKey, emailMode: this.#deps.emailMode },
          { applicantAccountId: view.accountId, jobId: jobId.value as number, coverNote: note === '' ? null : note },
        ),
      );
      if (outcome.ok === false) throw applyRefusal(outcome);
      reply.code(303).header('location', '/portal/applicant').send();
    });

    // --- S9/v9: the advertiser's page -----------------------------------------------------------
    app.get('/portal/advertiser', async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      if (!view.roles.includes('advertiser')) {
        this.#refuseRole(reply, view, 'advertiser');
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
        .send(page('Applications to your roles', advertiserPage(view.displayName, applications, csrf)));
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

    app.get('/portal/register', async (req: FastifyRequest, reply: FastifyReply) => {
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          page(
            'Create an account',
            `<h1>Create an account</h1>
<form method="post" action="/portal/register">
  <p><label for="email">Email</label>
     <input id="email" name="email" type="email" autocomplete="email" required></p>
  <p><label for="display">Name shown on your profile</label>
     <input id="display" name="display_name" autocomplete="name" maxlength="120" required></p>
  <p><label for="password">Password (at least ${PASSWORD_MIN} characters)</label>
     <input id="password" name="password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" required></p>
  <fieldset>
    <legend>What do you want to do?</legend>
    <label><input type="checkbox" name="role" value="applicant"> Find fractional work</label>
    <label><input type="checkbox" name="role" value="advertiser"> Advertise a role</label>
  </fieldset>
  <button type="submit">Create account</button>
</form>
<p>Already have one? <a href="/portal/signin">Sign in</a>.</p>`,
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
            page(
              'Check your email',
              `<h1>That address already has an account</h1>
<p>We have emailed ${escapeHtml(email)} a reminder of how to get in. If it does not arrive, sign in and use “forgot password”.</p>
<p><a href="/portal/signin">Sign in</a></p>`,
            ),
          );
        return;
      }

      // The secret is shown exactly once, here. There is no second chance to see it, and the
      // account cannot become active until a code from it has been entered.
      const link =
        result.verifyUrl === undefined
          ? '<p>We have emailed you a link to confirm your address.</p>'
          : `<p>Confirm your address: <a href="${escapeHtml(result.verifyUrl)}">${escapeHtml(result.verifyUrl)}</a></p>`;
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          page(
            'Set up your authenticator',
            `<h1>Set up your authenticator</h1>
<p>Add this account to an authenticator app (1Password, Authy, Google Authenticator). Type the key in by hand if you cannot scan.</p>
<p class="totp-secret"><code>${escapeHtml(result.totpGrouped)}</code></p>
<p><a href="${escapeHtml(result.otpauthUri)}">Open in your authenticator app</a></p>
${link}
<p>Your account stays inactive until you have confirmed the email and entered a code from the app.</p>`,
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
          .send(page('Link not valid', `<h1>Link not valid</h1><p>${escapeHtml(why)}</p>`));
        return;
      }
      if (outcome.next === 'active') {
        this.#clearEnrol(reply, tenantKey);
        reply
          .code(200)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(page('Address confirmed', `<h1>Address confirmed</h1><p><a href="/portal/signin">Sign in</a></p>`));
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
          page(
            'Enter a code',
            `<h1>One more step</h1>
<p>Enter the six-digit code from your authenticator app.</p>
<form method="post" action="/portal/enrol">
  <p><label for="code">Code</label>
     <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></p>
  <button type="submit">Confirm</button>
</form>`,
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
            page(
              'Wrong code',
              `<h1>That code is not right</h1>
<form method="post" action="/portal/enrol">
  <p><label for="code">Code</label>
     <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></p>
  <button type="submit">Try again</button>
</form>`,
            ),
          );
        return;
      }
      this.#clearEnrol(reply, tenantKey);
      reply.code(303).header('location', '/portal/signin').send();
    });

    app.get('/portal/signin', async (req: FastifyRequest, reply: FastifyReply) => {
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          page(
            'Sign in',
            `<h1>Sign in</h1>
<form method="post" action="/portal/signin">
  <p><label for="email">Email</label>
     <input id="email" name="email" type="email" autocomplete="email" required></p>
  <p><label for="password">Password</label>
     <input id="password" name="password" type="password" autocomplete="current-password" required></p>
  <p><label for="code">Authenticator code</label>
     <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></p>
  <button type="submit">Sign in</button>
</form>
<p><a href="/portal/register">Create an account</a></p>`,
          ),
        );
    });

    app.post('/portal/signin', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const fields = fieldsOf(req.body);
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
            page(
              'Sign in',
              `<h1>Sign in</h1>
<p role="alert">${escapeHtml(message)}</p>
<form method="post" action="/portal/signin">
  <p><label for="email">Email</label>
     <input id="email" name="email" type="email" autocomplete="email" required></p>
  <p><label for="password">Password</label>
     <input id="password" name="password" type="password" autocomplete="current-password" required></p>
  <p><label for="code">Authenticator code</label>
     <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></p>
  <button type="submit">Sign in</button>
</form>
<p><a href="/portal/register">Create an account</a></p>`,
            ),
          );
        return;
      }
      this.#setSession(reply, tenantKey, result.session);
      reply.code(303).header('location', '/portal').send();
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
