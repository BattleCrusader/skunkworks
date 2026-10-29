/**
 * `cms_profile`, read and written — the applicant's own record, in the two shapes it has.
 *
 * There are exactly two: the row (this module's business) and `ApplicantProfile` from
 * `policy.ts` (the policy's business). Nothing else reads the table. A route that selected the row
 * itself would be a second place where `skills_json` gets parsed, and the day one of them forgets a
 * field the other is the day a profile renders half-empty.
 *
 * **Contact is absent by construction.** The table has no `email`, no `phone` and no `address`
 * column, so neither function here can carry one; the projection in `policy.ts` has no field to put
 * one in either. Two independent absences, on purpose.
 */
import type Database from 'better-sqlite3';

import type { AccountStatus, ApplicantProfile, ProfileEdit } from './policy.ts';

interface ProfileRow {
  account_id: number;
  display_name: string;
  headline: string | null;
  summary: string | null;
  skills_json: string;
  hourly_rate_cents: number | null;
  currency: string;
  availability_days_per_week: number | null;
  location: string | null;
  timezone: string | null;
  work_mode: string;
  links_json: string;
  visibility: string;
  notify_new_jobs: number;
  status: string;
}

/** A JSON column that is not JSON is empty, never a crash on the page that renders it. */
function strings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function links(raw: string): { label: string; url: string }[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { label, url } = entry as { label?: unknown; url?: unknown };
      if (typeof label !== 'string' || typeof url !== 'string') return [];
      return [{ label, url }];
    });
  } catch {
    return [];
  }
}

/** The account holder's record as the policy takes it, or `null` when there is no profile row. */
export function loadProfile(db: Database.Database, accountId: number): ApplicantProfile | null {
  const row = db
    .prepare(
      `SELECT p.account_id, p.display_name, p.headline, p.summary, p.skills_json, p.hourly_rate_cents,
              p.currency, p.availability_days_per_week, p.location, p.timezone, p.work_mode,
              p.links_json, p.visibility, p.notify_new_jobs, a.status
         FROM cms_profile p JOIN cms_account a ON a.id = p.account_id
        WHERE p.account_id = ?`,
    )
    .get(accountId) as ProfileRow | undefined;
  if (row === undefined) return null;
  return {
    accountId: row.account_id,
    displayName: row.display_name,
    headline: row.headline,
    summary: row.summary,
    skills: strings(row.skills_json),
    hourlyRateCents: row.hourly_rate_cents,
    currency: row.currency,
    availabilityDaysPerWeek: row.availability_days_per_week,
    location: row.location,
    timezone: row.timezone,
    // The column's CHECK is the vocabulary; a value outside it cannot be in the row. The cast is
    // the reader's half of that constraint, and `parseWorkMode` is the writer's.
    workMode: row.work_mode === 'hybrid' || row.work_mode === 'remote' ? row.work_mode : 'onsite',
    links: links(row.links_json),
    // The column's CHECK is the vocabulary; a value outside it cannot be in the row. The cast is
    // the reader's half of that constraint, and `parseVisibility` is the writer's.
    visibility: row.visibility === 'discoverable' ? 'discoverable' : 'hidden',
    notifyNewJobs: row.notify_new_jobs === 1,
    status: row.status as AccountStatus,
  };
}

/**
 * Write the eight fields the applicant's form owns. Returns the number of rows the write touched,
 * so a caller can tell "saved" from "there is no profile for this account" instead of assuming.
 *
 * `skills`, `links`, `location`, `timezone` and `currency` are not in this statement: a form that
 * does not offer them must not be able to blank them by omission.
 */
export function saveProfile(
  db: Database.Database,
  accountId: number,
  edit: ProfileEdit,
  atMs: number,
): number {
  return db
    .prepare(
      `UPDATE cms_profile
          SET display_name = ?, headline = ?, summary = ?, hourly_rate_cents = ?,
              availability_days_per_week = ?, location = ?, work_mode = ?, visibility = ?,
              notify_new_jobs = ?, updated_at = ?
        WHERE account_id = ?`,
    )
    .run(
      edit.displayName.trim(),
      edit.headline,
      edit.summary,
      edit.hourlyRateCents,
      edit.availabilityDaysPerWeek,
      edit.location,
      edit.workMode,
      edit.visibility,
      edit.notifyNewJobs ? 1 : 0,
      new Date(atMs).toISOString(),
      accountId,
    ).changes;
}
