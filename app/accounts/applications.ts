/**
 * Applications — the row in `cms_application`, and the two lists that may be built from it.
 *
 * ## Why this is not in the plugin
 *
 * A plugin's `EndpointRequest` carries `{db, tenant, method, endpoint, body, url}` and **no actor**.
 * "May this viewer see this application" and "send mail to the advertiser" both need an identity, so
 * both belong in core, where the session and the CSRF secret live. The job board package keeps its
 * own tables and its own admin screens and is read here through the facade (`jobs.ts`); it never
 * learns that an application exists.
 *
 * ## The two grants, and why the advertiser's list is derived rather than filtered
 *
 * An application row is the only thing that lets an advertiser see a stranger's profile. So the
 * advertiser's list is built in this order, and every step is a check rather than a join:
 *
 *   1. rows where `advertiser_account_id = the caller` (the account scope);
 *   2. the advert named by `job_id`, read from the plugin (existence and title);
 *   3. the **company** that advert belongs to, and that company's owner — which must still be the
 *      caller. A row whose advertiser account disagrees with the advert's owner is stale or
 *      forged, and it renders nothing;
 *   4. `policy.projectProfile({kind:'advertiser', companyId, shares:true}, profile)` — where
 *      `companyId` came from step 3, never from the request.
 *
 * The order matters because step 4 is the only thing that decides what a field-level view looks
 * like, and it is reachable only through steps 1-3. A caller holding an application id from another
 * company cannot turn it into a profile, because there is no parameter to pass.
 *
 * ## Nothing here mails a stranger
 *
 * The only mail this module writes goes to the **advertiser's own address**, about an application
 * they own, and its template carries the applicant's display name, headline and the advert's title.
 * No address, no phone, no rate: `application_received` has no vars for them.
 */
import type Database from 'better-sqlite3';

import type { ProfileProjection } from './policy.ts';
import { PROFILE_LIMITS, projectProfile } from './policy.ts';
import { screenFreeText } from './pii.ts';
import { loadProfile } from './profile.ts';
import { advertReader, type AdvertReader } from './jobs.ts';

/** `cms_application.status`'s CHECK, in the column's order. */
export type ApplicationStatus = 'submitted' | 'withdrawn' | 'shortlisted' | 'rejected';

/** What an advertiser may set. `submitted` is the applicant's state and `withdrawn` theirs to keep. */
export const ADVERTISER_STATUSES = ['shortlisted', 'rejected'] as const;
export type AdvertiserStatus = (typeof ADVERTISER_STATUSES)[number];

/**
 * `cms_application.outcome`'s CHECK, in the column's order — the advertiser's **decision record**.
 *
 * **An outcome is not a status.** `status` is where the application is in the applicant's
 * lifecycle (`submitted`, or `withdrawn` because they took it back); `outcome` is what the company
 * concluded (shortlisted, interview requested, offer made, not successful). They are independent
 * facts about one row: a row can be `submitted` and carry `shortlisted`, and a withdrawn row is
 * over whatever the company had concluded. Writing an outcome never touches `status`, and
 * `setApplicationStatus` never touches an outcome — folding the two together would lose the
 * difference between "they walked away" and "we said no".
 */
export const OUTCOMES = ['shortlisted', 'interview', 'offer', 'rejected'] as const;
export type ApplicationOutcome = (typeof OUTCOMES)[number];

/** What the applicant reads, in the words the decision means rather than the column's slug. */
export const OUTCOME_LABELS: Readonly<Record<ApplicationOutcome, string>> = {
  shortlisted: 'Shortlisted',
  interview: 'Interview requested',
  offer: 'Offer made',
  rejected: 'Not successful',
};

/**
 * The sentence an applicant's page shows for a row. `null` is "no decision yet", which is the state
 * every application starts in; a withdrawn row reads "Not applicable" because the company's view of
 * it no longer means anything — and that is said by the page, not stored, so withdrawing does not
 * rewrite a decision an advertiser made.
 */
export function outcomeLabel(outcome: ApplicationOutcome | null): string {
  return outcome === null ? 'Not decided yet' : OUTCOME_LABELS[outcome];
}

/** The column's own bound. The CHECK is the control; this is the sentence a form can show first. */
export const OUTCOME_NOTE_MAX = 500;

/** One page of a portal list. A portal screen is not an export, and a person's inbox is not a feed. */
export const APPLICATIONS_PAGE = 100;

export interface ApplicationDeps {
  readonly db: Database.Database;
  readonly tenant: string;
  readonly emailMode: 'off' | 'smtp';
  /** The clock, injected so a test can order two rows without sleeping. */
  readonly now?: () => number;
}

export interface ApplicantApplication {
  readonly id: number;
  readonly jobId: number;
  /** The advert's title when the plugin can answer, `null` when it cannot. Never invented. */
  readonly jobTitle: string | null;
  readonly status: ApplicationStatus;
  /**
   * The company's decision record, beside the status rather than inside it. `null` is "not decided
   * yet" and the page says so in words; a withdrawn row is shown as "Not applicable".
   */
  readonly outcome: ApplicationOutcome | null;
  readonly outcomeNote: string | null;
  readonly outcomeAt: string | null;
  readonly createdAt: string;
}

export interface AdvertiserApplication {
  readonly id: number;
  readonly jobId: number;
  readonly jobTitle: string | null;
  readonly status: ApplicationStatus;
  readonly outcome: ApplicationOutcome | null;
  readonly outcomeNote: string | null;
  readonly outcomeAt: string | null;
  readonly createdAt: string;
  readonly coverNote: string | null;
  /** `null` when the applicant's profile is gone or its owner is not active — the row still shows. */
  readonly profile: ProfileProjection | null;
}

export type ApplyRefusal =
  | 'job_unknown'
  | 'job_not_open'
  | 'own_advert'
  | 'duplicate'
  | 'profile_hidden'
  | 'no_profile'
  | 'cover_note_too_long';

export type ApplyOutcome =
  | { readonly ok: true; readonly applicationId: number; readonly mailed: boolean }
  | { readonly ok: false; readonly reason: ApplyRefusal; readonly advertStatus?: string };

export type StatusOutcome =
  | { readonly ok: true; readonly status: AdvertiserStatus }
  | { readonly ok: false; readonly reason: 'not_found' | 'withdrawn' };

export type WithdrawOutcome =
  | { readonly ok: true; readonly status: 'withdrawn' }
  | { readonly ok: false; readonly reason: 'not_found' };

interface ApplicationRow {
  id: number;
  job_id: number;
  applicant_account_id: number;
  status: string;
  outcome: string | null;
  outcome_note: string | null;
  outcome_at: string | null;
  cover_note: string | null;
  created_at: string;
}

function at(deps: ApplicationDeps): number {
  return (deps.now ?? Date.now)();
}

function reader(deps: ApplicationDeps): AdvertReader {
  return advertReader(deps.db, deps.tenant, deps.emailMode);
}

/** `submitted` for anything the column's CHECK would refuse; the CHECK is the authority. */
function statusOf(raw: string): ApplicationStatus {
  return raw === 'withdrawn' || raw === 'shortlisted' || raw === 'rejected' ? raw : 'submitted';
}

/** `null` for "no decision" and for anything the column's CHECK would refuse. */
function outcomeOf(raw: string | null): ApplicationOutcome | null {
  return raw === 'shortlisted' || raw === 'interview' || raw === 'offer' || raw === 'rejected' ? raw : null;
}

/**
 * The applicant's own rows. `applicant_account_id = ?` is the entire authorisation, and it is in the
 * SQL rather than in a filter afterwards: a list that is fetched and then filtered is a list that
 * has been in memory. The advert title is decoration for the page — a row whose job has been
 * deleted still appears, named by its number, because the applicant is entitled to see that they
 * applied.
 */
export function applicationsForApplicant(deps: ApplicationDeps, accountId: number): ApplicantApplication[] {
  const rows = deps.db
    .prepare(
      `SELECT id, job_id, applicant_account_id, status, outcome, outcome_note, outcome_at,
              cover_note, created_at
         FROM cms_application
        WHERE applicant_account_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(accountId, APPLICATIONS_PAGE) as ApplicationRow[];
  const jobs = reader(deps);
  return rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    jobTitle: jobs.job(row.job_id)?.title ?? null,
    status: statusOf(row.status),
    outcome: outcomeOf(row.outcome),
    outcomeNote: row.outcome_note,
    outcomeAt: row.outcome_at,
    createdAt: row.created_at,
  }));
}

/**
 * The advertiser's rows, each with the projection the policy allows and nothing else.
 *
 * A row that cannot be proved — no advert, no company, a company owned by somebody else — is
 * **dropped**, not rendered half-way. The count the page shows is the count of rows that survived
 * all four steps, so a stale row cannot inflate an advertiser's sense of their pipeline either.
 */
export function applicationsForAdvertiser(deps: ApplicationDeps, accountId: number): AdvertiserApplication[] {
  const rows = deps.db
    .prepare(
      `SELECT id, job_id, applicant_account_id, status, outcome, outcome_note, outcome_at,
              cover_note, created_at
         FROM cms_application
        WHERE advertiser_account_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(accountId, APPLICATIONS_PAGE) as ApplicationRow[];

  const jobs = reader(deps);
  const out: AdvertiserApplication[] = [];
  for (const row of rows) {
    const job = jobs.job(row.job_id);
    if (job === null) continue;
    // The shares axis, derived: the advert's company, whose owner must be this caller.
    if (jobs.companyOwner(job.companyId) !== accountId) continue;
    const profile = loadProfile(deps.db, row.applicant_account_id);
    const projection =
      profile === null
        ? null
        : projectProfile({ kind: 'advertiser', companyId: job.companyId, shares: true }, profile);
    out.push({
      id: row.id,
      jobId: row.job_id,
      jobTitle: job.title,
      status: statusOf(row.status),
      outcome: outcomeOf(row.outcome),
      outcomeNote: row.outcome_note,
      outcomeAt: row.outcome_at,
      createdAt: row.created_at,
      coverNote: row.cover_note,
      profile: projection,
    });
  }
  return out;
}

/**
 * `POST /portal/applicant/apply`.
 *
 * Every refusal is named, and the order is the order a person would meet them: does the advert
 * exist, is it open, is it theirs, have they already applied, is their profile visible. The last two
 * are answered by the database rather than by a check-then-write: `UNIQUE(job_id,
 * applicant_account_id)` is what decides "already applied", and the read of `cms_profile` is what
 * decides "hidden" — a profile that is missing is refused separately, because "you have no profile"
 * and "your profile is hidden" are different sentences to the two different people who see them.
 *
 * The write and the advertiser's notification are one transaction. A row without its mail is a
 * silent application; a mail without its row is a notification about nothing.
 */
export function applyForJob(
  deps: ApplicationDeps,
  input: { readonly applicantAccountId: number; readonly jobId: number; readonly coverNote: string | null },
): ApplyOutcome {
  const { db } = deps;
  const jobs = reader(deps);
  const job = jobs.job(input.jobId);
  if (job === null) return { ok: false, reason: 'job_unknown' };
  if (job.status !== 'published') return { ok: false, reason: 'job_not_open', advertStatus: job.status };

  const advertiserAccountId = jobs.companyOwner(job.companyId);
  // Without an owner there is nobody to apply to; the advert is unowned content, not a person.
  if (advertiserAccountId === null) return { ok: false, reason: 'job_unknown' };
  if (advertiserAccountId === input.applicantAccountId) return { ok: false, reason: 'own_advert' };

  const profile = loadProfile(db, input.applicantAccountId);
  if (profile === null) return { ok: false, reason: 'no_profile' };
  // Discoverability is the precondition for applying, not just for being matched: a hidden profile
  // cannot enter an advertiser's view by the back door of an application.
  if (profile.visibility !== 'discoverable') return { ok: false, reason: 'profile_hidden' };

  const note = input.coverNote === null ? null : input.coverNote.trim();
  if (note !== null && note.length > PROFILE_LIMITS.coverNote) {
    return { ok: false, reason: 'cover_note_too_long' };
  }

  const atMs = at(deps);
  const iso = new Date(atMs).toISOString();
  try {
    const applicationId = db.transaction((): number => {
      const info = db
        .prepare(
          `INSERT INTO cms_application
             (job_id, advertiser_account_id, applicant_account_id, cover_note, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'submitted', ?, ?)`,
        )
        .run(input.jobId, advertiserAccountId, input.applicantAccountId, note === '' ? null : note, iso, iso);
      const id = Number(info.lastInsertRowid);
      enqueueApplicationMail(db, {
        applicationId: id,
        advertiserAccountId,
        jobTitle: job.title,
        displayName: profile.displayName,
        headline: profile.headline,
        at: iso,
      });
      return id;
    })();
    return { ok: true, applicationId, mailed: true };
  } catch (err) {
    // The constraint is the authority on "already applied": two simultaneous posts both reach the
    // INSERT, and exactly one of them lands.
    const code = (err as { code?: string }).code ?? '';
    if (code.startsWith('SQLITE_CONSTRAINT')) return { ok: false, reason: 'duplicate' };
    throw err;
  }
}

/** One outbox row, to the advertiser about their own advert. Idempotent on the application id. */
function enqueueApplicationMail(
  db: Database.Database,
  mail: {
    readonly applicationId: number;
    readonly advertiserAccountId: number;
    readonly jobTitle: string;
    readonly displayName: string;
    readonly headline: string | null;
    readonly at: string;
  },
): void {
  const to = db.prepare('SELECT email FROM cms_account WHERE id = ?').get(mail.advertiserAccountId) as
    | { email: string }
    | undefined;
  if (to === undefined) throw new Error('an application cannot exist without an advertiser account');
  const subject = `New application for ${mail.jobTitle}`.slice(0, 200);
  db.prepare(
    `INSERT INTO cms_mail (to_email, template, subject, vars_json, idempotency_key, created_at)
     VALUES (?, 'application_received', ?, ?, ?, ?)`,
  ).run(
    to.email,
    subject,
    JSON.stringify({
      job_title: mail.jobTitle,
      applicant_name: mail.displayName,
      // The two fields the template is allowed to know. `null` becomes `''` in the renderer, so a
      // person with no headline simply reads a shorter message.
      applicant_headline: mail.headline ?? '',
    }),
    `application:${mail.applicationId}`,
    mail.at,
  );
}

/**
 * `POST /portal/applicant/withdraw` — the applicant takes their own application back.
 *
 * The scope is in both statements: `applicant_account_id = ?` on the read and on the write, so an
 * application belonging to somebody else is not one this account can name, let alone change.
 *
 * **Idempotent by design.** A second click, a reloaded POST or two tabs racing are all the same
 * answer: the row says `withdrawn`, and it said so already. Only a row that does not exist for this
 * applicant is a refusal, and then only by name (`not_found` → 404). An applicant may withdraw a
 * row that was shortlisted or rejected — it is their application — and what they cannot do is
 * un-withdraw it.
 */
export function withdrawApplication(
  deps: ApplicationDeps,
  input: { readonly applicationId: number; readonly applicantAccountId: number },
): WithdrawOutcome {
  const row = deps.db
    .prepare('SELECT status FROM cms_application WHERE id = ? AND applicant_account_id = ?')
    .get(input.applicationId, input.applicantAccountId) as { status: string } | undefined;
  if (row === undefined) return { ok: false, reason: 'not_found' };
  if (statusOf(row.status) === 'withdrawn') return { ok: true, status: 'withdrawn' };

  // `status <> 'withdrawn'` in the WHERE clause, not only in the read above: two requests can both
  // pass the read, and the second must not write a row the first already ended.
  deps.db
    .prepare(
      `UPDATE cms_application SET status = 'withdrawn', updated_at = ?
        WHERE id = ? AND applicant_account_id = ? AND status <> 'withdrawn'`,
    )
    .run(new Date(at(deps)).toISOString(), input.applicationId, input.applicantAccountId);
  return { ok: true, status: 'withdrawn' };
}

/**
 * `POST /portal/advertiser/application` — shortlist or reject, on a row the caller owns.
 *
 * The scope is in the WHERE clause twice: `advertiser_account_id = ?` on the read *and* on the
 * write, so a row that changed hands between the two cannot be written. `withdrawn` is refused by
 * name rather than overwritten: an applicant who took their application back has ended the
 * conversation, and an advertiser's click must not reopen it.
 */
export function setApplicationStatus(
  deps: ApplicationDeps,
  input: { readonly applicationId: number; readonly advertiserAccountId: number; readonly status: AdvertiserStatus },
): StatusOutcome {
  const row = deps.db
    .prepare('SELECT status FROM cms_application WHERE id = ? AND advertiser_account_id = ?')
    .get(input.applicationId, input.advertiserAccountId) as { status: string } | undefined;
  if (row === undefined) return { ok: false, reason: 'not_found' };
  if (statusOf(row.status) === 'withdrawn') return { ok: false, reason: 'withdrawn' };

  const changed = deps.db
    .prepare(
      `UPDATE cms_application SET status = ?, updated_at = ?
        WHERE id = ? AND advertiser_account_id = ? AND status <> 'withdrawn'`,
    )
    .run(input.status, new Date(at(deps)).toISOString(), input.applicationId, input.advertiserAccountId).changes;
  return changed === 1 ? { ok: true, status: input.status } : { ok: false, reason: 'withdrawn' };
}

export type OutcomeRefusal =
  | 'not_found'
  | 'withdrawn'
  | 'unknown_outcome'
  | 'note_too_long'
  | 'note_email'
  | 'note_phone'
  | 'note_address'
  | 'note_sensitive';

export type OutcomeResult =
  | { readonly ok: true; readonly outcome: ApplicationOutcome; readonly note: string | null }
  | { readonly ok: false; readonly reason: OutcomeRefusal };

/**
 * `POST /portal/advertiser/outcome` — the company records what it concluded about one application.
 *
 * **This never writes `status`.** An outcome is an advisory record stored beside the applicant's
 * lifecycle: a submitted row can carry `shortlisted` while still being `submitted`, and a withdrawn
 * row is over whatever the company concluded. The two columns are written by different functions
 * and read by different screens, so neither can quietly become the other.
 *
 * The scope is in the read *and* in the write: `advertiser_account_id = ?` in both statements, so a
 * row that changed hands between them cannot be written. `withdrawn` is refused by name rather than
 * overwritten — the applicant ended the conversation, and a decision recorded after that would be a
 * decision nobody is waiting for.
 *
 * The note is free text the **applicant will read**, so it is screened by `screenFreeText` before it
 * can reach a row and bounded at the column's 500 characters. A refused note is a refusal, not a
 * silent strip: the advertiser is told which kind of detail must come out, and nothing is written.
 */
export function recordOutcome(
  deps: ApplicationDeps,
  input: {
    readonly applicationId: number;
    readonly advertiserAccountId: number;
    readonly outcome: string;
    readonly note: string | null;
  },
): OutcomeResult {
  const row = deps.db
    .prepare('SELECT status FROM cms_application WHERE id = ? AND advertiser_account_id = ?')
    .get(input.applicationId, input.advertiserAccountId) as { status: string } | undefined;
  if (row === undefined) return { ok: false, reason: 'not_found' };
  if (statusOf(row.status) === 'withdrawn') return { ok: false, reason: 'withdrawn' };
  if (!(OUTCOMES as readonly string[]).includes(input.outcome)) return { ok: false, reason: 'unknown_outcome' };

  const trimmed = input.note === null ? '' : input.note.trim();
  if (trimmed.length > OUTCOME_NOTE_MAX) return { ok: false, reason: 'note_too_long' };
  if (trimmed !== '') {
    const screened = screenFreeText(trimmed);
    if (!screened.ok) {
      return {
        ok: false,
        reason:
          screened.reason === 'email'
            ? 'note_email'
            : screened.reason === 'phone'
              ? 'note_phone'
              : screened.reason === 'address'
                ? 'note_address'
                : 'note_sensitive',
      };
    }
  }
  const note = trimmed === '' ? null : trimmed;
  const iso = new Date(at(deps)).toISOString();

  // `status` is absent from this statement on purpose: an outcome is a record beside the lifecycle,
  // never a transition of it. `status <> 'withdrawn'` keeps the read's refusal honest under a race.
  const changed = deps.db
    .prepare(
      `UPDATE cms_application
          SET outcome = ?, outcome_note = ?, outcome_at = ?, outcome_by_account_id = ?, updated_at = ?
        WHERE id = ? AND advertiser_account_id = ? AND status <> 'withdrawn'`,
    )
    .run(
      input.outcome,
      note,
      iso,
      input.advertiserAccountId,
      iso,
      input.applicationId,
      input.advertiserAccountId,
    ).changes;
  return changed === 1
    ? { ok: true, outcome: input.outcome as ApplicationOutcome, note }
    : { ok: false, reason: 'withdrawn' };
}
