/**
 * Who may see which field of an applicant's profile — **the one place that decides it**.
 *
 * The job board's promise is narrow and testable: *an advertiser never learns anything about a
 * person except what that person chose to show, and never learns their contact details at all.*
 * That promise is not a convention spread across handlers, templates and SQL — a rule enforced in
 * four places is a rule with four ways to be wrong. It is this function: every route that renders
 * or serialises a profile, and every query that selects one for notification, calls into here.
 *
 * Three axes, kept separate because collapsing them is how job boards leak:
 *
 *   1. **`visibility`** — is this person *discoverable* (their profile may be matched against new
 *      jobs, and they may be notified)? A hidden profile is never enumerated, never matched, and
 *      never emailed. It does not mean "invisible to an advertiser I applied to": an application
 *      is itself an act of sharing, so `shares` below is a separate grant.
 *   2. **`shares`** — an advertiser is looking at someone who applied to *their* job. That is a
 *      deliberate disclosure by the applicant, and it is the ONLY way an advertiser reaches a
 *      profile at all. There is no directory for advertisers, and no id they can guess: the caller
 *      derives `shares` from an application row scoped to that advertiser's company, never from a
 *      query parameter.
 *   3. **contact** — `email` and any phone/address are **never** in a projection, for anybody but
 *      the account holder and the tenant operator. Contact happens through the platform (an
 *      application, which the applicant sent). A projection type that has no field for an address
 *      cannot leak one by accident, so the projection return type deliberately omits it — that is
 *      this module's most important property.
 *
 * `public` exists as a viewer so that "is there an anonymous profile page?" is answered here,
 * once, with `null`. There is not: profile pages are authenticated and scoped.
 */

/** A profile's discoverability, as the account holder sets it. Default is `hidden`. */
export type ProfileVisibility = 'hidden' | 'discoverable';

/**
 * The closed vocabulary, parsed from a form field.
 *
 * `null` for anything else — including a plausible third word. There are two states because the
 * column has two; a form that invented a third would be a form that writes a value the CHECK
 * refuses, and the person would see `SQLITE_CONSTRAINT` instead of a sentence. Adding a state is a
 * migration, a change to this union and a decision recorded here — not a string a route accepts.
 */
export function parseVisibility(raw: string): ProfileVisibility | null {
  return raw === 'hidden' || raw === 'discoverable' ? raw : null;
}

/**
 * The bounds a profile form enforces, each one either the column's own CHECK or the size of the
 * screen that renders it. They live here, beside the vocabulary, so the form and the table cannot
 * disagree about what a display name is.
 */
export const PROFILE_LIMITS = Object.freeze({
  displayName: 120,
  headline: 200,
  summary: 4_000,
  coverNote: 4_000,
});

/**
 * What a profile form may change — deliberately not the whole record.
 *
 * `skills`, `links`, `currency` and `location` are not fields here because the applicant's form does
 * not offer them, and a type with no field for a value cannot be talked into writing one. There is
 * also no `email`, no `phone` and no `address`: `cms_profile` has no such column, and this is the
 * second place (after the DDL) where that fact is expressed.
 */
export interface ProfileEdit {
  readonly displayName: string;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly dayRateCents: number | null;
  readonly availabilityDaysPerWeek: number | null;
  readonly remoteOk: boolean;
  readonly visibility: ProfileVisibility;
  readonly notifyNewJobs: boolean;
}

/**
 * The refusal, as a sentence, or `null`.
 *
 * Every rule below is one the database already enforces; this function exists so the person filling
 * the form is told *which* field is wrong instead of being handed a constraint name. It is checked
 * before the write, and the write still goes through the CHECKs — the validator is a courtesy, the
 * constraint is the control.
 */
export function profileEditProblem(edit: ProfileEdit): string | null {
  if (edit.displayName.trim().length < 1 || edit.displayName.trim().length > PROFILE_LIMITS.displayName) {
    return `A display name is 1 to ${PROFILE_LIMITS.displayName} characters.`;
  }
  if (edit.headline !== null && edit.headline.length > PROFILE_LIMITS.headline) {
    return `A headline is at most ${PROFILE_LIMITS.headline} characters.`;
  }
  if (edit.summary !== null && edit.summary.length > PROFILE_LIMITS.summary) {
    return `A summary is at most ${PROFILE_LIMITS.summary} characters.`;
  }
  if (edit.dayRateCents !== null && (!Number.isInteger(edit.dayRateCents) || edit.dayRateCents <= 0)) {
    return 'A day rate is a whole number of cents, and more than zero.';
  }
  if (
    edit.availabilityDaysPerWeek !== null &&
    (!Number.isInteger(edit.availabilityDaysPerWeek) ||
      edit.availabilityDaysPerWeek < 1 ||
      edit.availabilityDaysPerWeek > 7)
  ) {
    return 'Availability is 1 to 7 days a week.';
  }
  // `visibility` and the two booleans are already typed; a caller cannot pass a third state without
  // changing this file. The one rule worth stating anyway is the one the product promises: opt-in
  // mail requires a discoverable profile, and `mayNotify` below is where that is decided.
  return null;
}

/** The account holder's own record, before projection. Never leaves the server in this shape. */
export interface ApplicantProfile {
  readonly accountId: number;
  readonly displayName: string;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly skills: readonly string[];
  readonly dayRateCents: number | null;
  readonly currency: string;
  readonly availabilityDaysPerWeek: number | null;
  readonly location: string | null;
  readonly timezone: string | null;
  readonly remoteOk: boolean;
  /** `{label, url}` pairs the applicant supplied (portfolio, repository, writing). */
  readonly links: readonly { readonly label: string; readonly url: string }[];
  readonly visibility: ProfileVisibility;
  /** Explicit opt-in for "new job matches" mail. Default off; see `mayNotify`. */
  readonly notifyNewJobs: boolean;
  readonly status: AccountStatus;
}

/** The account's lifecycle. Only `active` may do anything at all. */
export type AccountStatus = 'pending' | 'active' | 'suspended' | 'closed';

export type Viewer =
  /** The account holder, looking at their own profile. */
  | { readonly kind: 'self' }
  /**
   * A tenant operator (the box's own admin). They run the tenant and can read the record to
   * support it — but the caller must write an audit row, and this projection still carries no
   * contact field, because the operator's screen has no reason to render one for a support task.
   */
  | { readonly kind: 'operator' }
  /**
   * An advertiser. `shares` is true only when the caller has already proved that this applicant
   * applied to a job owned by `companyId`. `companyId` is carried so the decision can name it and
   * so a caller that forgets to scope its query still cannot pass a bare `{kind:'advertiser'}`.
   */
  | { readonly kind: 'advertiser'; readonly companyId: number; readonly shares: boolean }
  /** Anonymous. Answered once: nothing. */
  | { readonly kind: 'public' };

/** What an authorised viewer receives. Note what is absent: no email, no account id, no flags. */
export interface ProfileProjection {
  readonly displayName: string;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly skills: readonly string[];
  readonly dayRateCents: number | null;
  readonly currency: string;
  readonly availabilityDaysPerWeek: number | null;
  readonly location: string | null;
  readonly timezone: string | null;
  readonly remoteOk: boolean;
  readonly links: readonly { readonly label: string; readonly url: string }[];
  /** Which of the applicant's choices produced this view — rendered as a note, never as data. */
  readonly basis: 'self' | 'operator' | 'application' | 'discoverable';
}

/**
 * The single projection function.
 *
 * Returns `null` when the viewer may see nothing at all — the caller must then answer exactly as
 * it would for a profile that does not exist (404 with no distinguishing detail), so an id or an
 * email cannot be probed by watching status codes or response sizes.
 */
export function projectProfile(viewer: Viewer, profile: ApplicantProfile): ProfileProjection | null {
  // A pending, suspended or closed account is not visible to anyone but itself and the operator.
  // Activation is a precondition for being discoverable or for having applications considered.
  const ownerScope = viewer.kind === 'self' || viewer.kind === 'operator';
  if (!ownerScope && profile.status !== 'active') return null;

  switch (viewer.kind) {
    case 'self':
      return view(profile, 'self');
    case 'operator':
      return view(profile, 'operator');
    case 'public':
      // Deliberate: there is no anonymous profile page on this board.
      return null;
    case 'advertiser': {
      // An application is the grant. Discoverability is *not* a grant to browse: a discoverable
      // profile may be matched and notified, and nothing more.
      if (!viewer.shares) return null;
      // Belt and braces: a caller that has an application has a company; an application cannot
      // exist without one. `companyId` being a positive integer is the shape check, so a
      // caller passing 0/NaN is refused rather than silently treated as "some company".
      if (!Number.isInteger(viewer.companyId) || viewer.companyId <= 0) return null;
      return view(profile, 'application');
    }
  }
}

/** The body of a projection. One construction site, so every field is a decision in one place. */
function view(profile: ApplicantProfile, basis: ProfileProjection['basis']): ProfileProjection {
  return {
    displayName: profile.displayName,
    headline: profile.headline,
    summary: profile.summary,
    skills: [...profile.skills],
    dayRateCents: profile.dayRateCents,
    currency: profile.currency,
    availabilityDaysPerWeek: profile.availabilityDaysPerWeek,
    location: profile.location,
    timezone: profile.timezone,
    remoteOk: profile.remoteOk,
    links: profile.links.map((l) => ({ label: l.label, url: l.url })),
    basis,
  };
}

/**
 * May this applicant be **matched against a new job and emailed about it**?
 *
 * This is the query predicate for the fan-out in requirement 5, and it is intentionally stricter
 * than "has a profile": the account must be active, the profile must be discoverable, and the
 * person must have opted in to this class of mail. Unsolicited mail to a discoverable profile is
 * still unsolicited mail; `notifyNewJobs` defaults to false and is only ever set by the holder.
 */
export function mayNotify(profile: ApplicantProfile): boolean {
  return profile.status === 'active' && profile.visibility === 'discoverable' && profile.notifyNewJobs;
}

/**
 * Does this applicant match a job's declared skills, for that fan-out?
 *
 * The rule is deliberately conservative, and it is stated once so the notification query and the
 * "why did I get this" line in the email cannot disagree:
 *
 *   - a job that declares **no** skills matches every notifiable applicant (it is open work);
 *   - otherwise the applicant must share **at least one** skill, compared case-insensitively on
 *     a trimmed string. No fuzzy matching, no synonyms: a wrong match mails a stranger, and the
 *     cost of a missed match is one fewer applicant, which is the cheaper mistake.
 */
export function matchesJobSkills(profile: ApplicantProfile, jobSkills: readonly string[]): boolean {
  const normalise = (s: string): string => s.trim().toLowerCase();
  const wanted = jobSkills.map(normalise).filter((s) => s !== '');
  if (wanted.length === 0) return true;
  const held = new Set(profile.skills.map(normalise).filter((s) => s !== ''));
  return wanted.some((s) => held.has(s));
}

/**
 * **Contact is never projected.** This function exists so that a route which wants to show an
 * applicant's address has one, named place to be refused, rather than reaching for a column.
 * Nothing in the product calls it except the tests that assert the refusal.
 */
export function mayShareContact(_viewer: Viewer): false {
  return false;
}
