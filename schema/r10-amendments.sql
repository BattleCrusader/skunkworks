-- r10-amendments.sql — the v9 -> v10 delta for a tenant site.db.
--
-- Applies to a site.db at PRAGMA user_version = 9 and yields 10, which is the shape
-- schema/site.sql now generates. Convergence on the fresh DDL is asserted by
-- scripts/model/verify_claims.py check 20 (table set, column set, trigger set, index set and the
-- canonical table text), so this file and the generator cannot drift without `make test` failing.
--
-- WHAT THIS CHANGES AND WHY (the owner's four corrections — rate, arrangement)
--
--   `cms_profile.hourly_rate_cents` replaces `cms_profile.day_rate_cents`.
--
--     The board sells hours, not days. A day rate is a rate whose unit nobody states: "1,200 a day"
--     is 150 an hour at eight hours and 200 an hour at six, so the number an applicant typed and
--     the number an advertiser compared were never the same quantity. Dollars are what a person
--     types and reads; cents are what the column stores, because money that is a float is money
--     that rounds. The ceiling is $5,000 an hour: past it the value is a typo, not a price.
--
--     The old day rate is **not converted**. Eight hours is a convention this product has never
--     stated, and inventing one would put a price in a person's mouth that they never quoted. The
--     field is empty after this migration — the same state as "not stated", which the form already
--     offers — and the applicant is asked for an hourly rate next time they open their profile.
--
--   `cms_profile.work_mode` replaces `cms_profile.remote_ok`.
--
--     A yes/no flag cannot say "hybrid", which is the arrangement most of this board's work is.
--     The three states are the whole vocabulary; the column's CHECK is the control and
--     `app/accounts/policy.ts`'s parser is the courtesy that turns a bad word into a sentence.
--     The old flag maps honestly: 1 was "remote ok" (and was the only way to say it), so it becomes
--     'remote'; 0 becomes the column's own default, 'onsite'.
--
-- One table is altered in place: two ADD COLUMNs, the backfill, two DROP COLUMNs. No rebuild, so
-- `ix_profile_discovery` survives untouched and no row id moves. Every existing row keeps every
-- column this file does not name — the profile is a person's record, and a migration that rebuilt
-- it would be a migration that could drop one.
--
-- The job board's `p_jobboard_job` is the package's table, not this file's: it moves by
-- re-installing plugins/jobboard (the installer owns those tables and drops them on uninstall).

-- 1. The hourly rate, in cents, with the ceiling the form also enforces.
ALTER TABLE cms_profile ADD COLUMN hourly_rate_cents INTEGER
  CHECK(hourly_rate_cents IS NULL OR (hourly_rate_cents > 0 AND hourly_rate_cents <= 500000));

-- 2. The arrangement, as a closed three-word vocabulary. NOT NULL with a default, so the ADD
--    succeeds on a populated table; the default is the state a row with no answer was in.
ALTER TABLE cms_profile ADD COLUMN work_mode TEXT NOT NULL DEFAULT 'onsite'
  CHECK(work_mode IN ('onsite','hybrid','remote'));

-- 3. The old flag, carried across before it is dropped: 1 meant "remote ok", which is 'remote'.
UPDATE cms_profile SET work_mode = CASE WHEN remote_ok = 1 THEN 'remote' ELSE 'onsite' END;

-- 4. The columns the product no longer has. Dropped after the backfill, never before it.
ALTER TABLE cms_profile DROP COLUMN day_rate_cents;
ALTER TABLE cms_profile DROP COLUMN remote_ok;

PRAGMA user_version = 10;
