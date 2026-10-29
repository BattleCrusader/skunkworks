-- r11-amendments.sql — the v10 -> v11 delta for a tenant site.db.
--
-- Applies to a site.db at PRAGMA user_version = 10 and yields 11, which is the shape
-- schema/site.sql now generates. Convergence on the fresh DDL is asserted by
-- scripts/model/verify_claims.py check 20 (table set, column set, trigger set, index set and the
-- canonical table text), so this file and the generator cannot drift without `make test` failing.
--
-- WHAT THIS CHANGES AND WHY (the owner's three corrections — the set, the link, the outcome)
--
--   `cms_profile.work_modes_json` replaces `cms_profile.work_mode`.
--
--     What a person will accept is a SET. "On-site, hybrid or remote" was the form's question and
--     the single column forced an answer to it, but a fractional worker's real answer is often
--     "any of the three" or "hybrid and remote, not five days on-site" — a set, in any combination.
--     The model said otherwise, so the form drew radios and the profile lost two thirds of what the
--     person meant. The new column holds an array of the same three words; the old value is carried
--     across as a ONE-ELEMENT array, which is the honest translation: a person who said 'hybrid'
--     under the old model had the option to say one thing, so 'hybrid' is exactly what they said.
--     No row loses its answer and none is invented — a row with 'onsite' becomes `["onsite"]`, not
--     `["onsite","hybrid","remote"]`.
--
--     The advert keeps its own single `work_mode` (plugins/jobboard/plugin.json): a ROLE has one
--     arrangement, and a set there would describe a job nobody is offering. The two sides of the
--     board therefore speak the same three words in different shapes, deliberately.
--
--   `cms_application.outcome`, `outcome_note`, `outcome_at`, `outcome_by_account_id` are new.
--
--     The advertiser's decision is a record BESIDE the application's own `status`, not a transition
--     of it. `status` says where the application is in the applicant's lifecycle — `submitted`, or
--     `withdrawn` because they took it back — and `outcome` says what the company concluded:
--     shortlisted, interview requested, offer made, not successful. They are independent facts
--     about one row: a submitted row can carry 'shortlisted' without its status changing, and a
--     withdrawn row is over whatever the company had concluded. Folding the two together would
--     lose the distinction between "they walked away" and "we said no", which is the one thing an
--     advertiser reading a pipeline needs.
--
--     `outcome_note` is free text the applicant will read, so it is screened by
--     `app/accounts/pii.ts#screenFreeText` before it is written and bounded at 500 characters; the
--     column's CHECK is the bound behind the screen. `outcome_by_account_id` names who recorded it.
--
-- One table is altered in place for each group: ADD COLUMNs, one backfill, one DROP COLUMN on the
-- profile; ADD COLUMNs only on the application. No rebuild, so `ix_profile_discovery`,
-- `ix_application_job`, `ix_application_advertiser` and `ix_application_applicant` survive
-- untouched and no row id moves. Every existing row keeps every column this file does not name —
-- a profile and an application are records about two people, and a migration that rebuilt either
-- would be a migration that could drop one.
--
-- The job board's `p_jobboard_job.work_mode` is the package's column, not this file's: it does not
-- move, and its vocabulary is unchanged.

-- 1. The arrangement, as a set. NOT NULL with an empty-array default, so the ADD succeeds on a
--    populated table; '[]' is the state a row with no answer was in, and the form refuses it.
ALTER TABLE cms_profile ADD COLUMN work_modes_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(work_modes_json));

-- 2. The old single value, carried across as a one-element array. `json_array` writes real JSON
--    (quoted, escaped) rather than string concatenation, so the value is a JSON array and not a
--    string that happens to look like one. The column's NOT NULL means there is no NULL case to
--    invent an answer for.
UPDATE cms_profile SET work_modes_json = json_array(work_mode);

-- 3. The column the product no longer has. Dropped after the backfill, never before it.
ALTER TABLE cms_profile DROP COLUMN work_mode;

-- 4. The advertiser's outcome, beside the applicant's status. Four nullable columns, no default:
--    NULL is "not decided yet", which is the state every existing application is in and the state
--    the applicant's page says in words.
ALTER TABLE cms_application ADD COLUMN outcome TEXT
  CHECK(outcome IS NULL OR outcome IN ('shortlisted','interview','offer','rejected'));
ALTER TABLE cms_application ADD COLUMN outcome_note TEXT
  CHECK(outcome_note IS NULL OR length(outcome_note) BETWEEN 1 AND 500);
ALTER TABLE cms_application ADD COLUMN outcome_at TEXT;
-- No ON DELETE action, deliberately: the column records WHO decided. `SET NULL` would turn a
-- recorded decision into an anonymous one, and the row's own advertiser account already cascades,
-- so deleting the company that decided takes the application with it.
ALTER TABLE cms_application ADD COLUMN outcome_by_account_id INTEGER REFERENCES cms_account(id);

PRAGMA user_version = 11;
