-- r9-amendments.sql — the v8 -> v9 delta for a tenant site.db.
--
-- Applies to a site.db at PRAGMA user_version = 8 and yields 9, which is the shape
-- schema/site.sql now generates. Convergence on the fresh DDL is asserted by
-- scripts/model/verify_claims.py check 20 (table set, column set, trigger set, index set and the
-- canonical table text), so this file and the generator cannot drift without `make test` failing.
--
-- WHAT THIS ADDS AND WHY (S9, docs/sds/03-jobboard.md)
--
--   `cms_application` — the act of applying. One row per (job, applicant), written by the portal.
--
--   It is CORE, not a p_jobboard_* table, and the reason is structural rather than stylistic:
--   a plugin's `EndpointRequest` carries `{db, tenant, method, endpoint, body, url}` and no actor,
--   so a package can neither answer "may this viewer see this application" nor send mail about it.
--   The decision belongs in app/accounts/policy.ts, which needs an actor and a session; the row
--   therefore lives where that code can read it.
--
--   Three consequences expressed as constraints, because a handler can be forgotten:
--
--     * `job_id` has NO foreign key. It names a row in the job board plugin's `p_jobboard_job`,
--       and `app/plugins/install.ts` DROPs every table a manifest declares. A core table with an
--       FK into a p_* table would make that plugin uninstallable, so the reference is by id and
--       the portal re-reads the advert (read-only, through the plugin facade) to decide anything.
--     * `UNIQUE(job_id, applicant_account_id)` is what makes a second application the same
--       application rather than a duplicate; the portal turns the constraint into a sentence.
--     * `CHECK(applicant_account_id <> advertiser_account_id)` — an account cannot apply to its
--       own advert. Roles are additive (`cms_account_role`), so one person may hold both; the
--       constraint is what stops that person congratulating themselves.
--
--   Nothing existing is touched: one table, three indexes, and a version pragma. No rebuild, no
--   backfill — a tenant whose board has never received an application simply has no rows.

CREATE TABLE cms_application (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL CHECK(job_id > 0),
  advertiser_account_id INTEGER NOT NULL REFERENCES cms_account(id) ON DELETE CASCADE,
  applicant_account_id INTEGER NOT NULL REFERENCES cms_account(id) ON DELETE CASCADE,
  cover_note TEXT CHECK(cover_note IS NULL OR length(cover_note) BETWEEN 1 AND 4000),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','withdrawn','shortlisted','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ux_application UNIQUE(job_id, applicant_account_id),
  CHECK(applicant_account_id <> advertiser_account_id)
);
CREATE INDEX ix_application_job ON cms_application(job_id, status);
CREATE INDEX ix_application_advertiser ON cms_application(advertiser_account_id, status);
CREATE INDEX ix_application_applicant ON cms_application(applicant_account_id, created_at);

PRAGMA user_version = 9;
