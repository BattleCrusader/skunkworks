-- schema/control-r4.sql — the v3 -> v4 delta for the control plane (02-errata E-20).
-- Applies to a control.db at PRAGMA user_version = 3 and yields 4 == schema/control.sql.
-- Convergence is asserted by verify_claims.py check 20 and by test/migrate.test.ts.
--
-- The CREATE TABLE text below is byte-identical to the block scripts/model/gen_schema.py
-- emits into schema/control.sql, because check 20 compares `sqlite_master.sql` text and a
-- DROP+CREATE in a delta must land on the same schema a fresh file gets. The whitespace is
-- therefore the generator's, not the errata's typography; the columns, CHECKs, PK, indexes
-- and trigger are the errata's, verbatim in meaning and order.
--
-- Why a DROP and not an ALTER: every surviving column changes meaning. `rows` was
-- count(cms_audit) (a whole-file snapshot); `rows_in_day` is the count of one day's id range.
-- The old rows carry no id boundary, so no row of them is a segment and none can be migrated
-- into the new shape. Their evidence is preserved in `audit_log` first; the days they covered
-- become visibly unsealed under E-20 rule (c), which is the truthful state.
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

-- 1. The cumulative anchor rows are not expressible as segments. Record each one, then replace.
INSERT INTO audit_log (tenant_id, actor_user_id, actor_label, action, target_kind, target_id,
                       before_json, after_json)
SELECT NULL, NULL, 'migration', 'audit.seal_discarded', 'audit_seal', s.tenant_key || '/' || s.day,
       json_object('rows', s.rows, 'head', s.head, 'sealed_at', s.sealed_at), NULL
  FROM audit_seal s;

-- 2. Replace the table. A DROP, not an ALTER: every surviving column changes meaning.
DROP INDEX IF EXISTS ix_seal_day;
DROP TABLE audit_seal;

CREATE TABLE audit_seal (
  tenant_key TEXT NOT NULL CHECK(length(tenant_key) BETWEEN 2 AND 40),
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(day) IS NOT NULL),
  first_id INTEGER NOT NULL CHECK(first_id >= 1),
  last_id INTEGER NOT NULL CHECK(last_id >= first_id),
  rows_in_day INTEGER NOT NULL CHECK(rows_in_day >= 1),
  anchor TEXT NOT NULL CHECK(length(anchor) IN (0, 64)),
  head TEXT NOT NULL CHECK(length(head) = 64),
  sealed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  late INTEGER NOT NULL DEFAULT 0 CHECK(late IN (0, 1)),
  PRIMARY KEY(tenant_key, day),
  CHECK(date(day) IS NOT NULL),
  CHECK(late = 1 OR substr(sealed_at, 1, 10) = date(day, '+1 day'))
);
CREATE INDEX ix_seal_day ON audit_seal(day);
CREATE INDEX ix_seal_late ON audit_seal(tenant_key, late);

-- 3. The anchor is immutable. A re-seal is a refusal in the app and an ABORT in the database,
--    because the app is not the only thing that can write this file.
CREATE TRIGGER trg_audit_seal_immutable BEFORE UPDATE ON audit_seal
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_SEC_AUDIT_SEAL');
END;

-- 3. Two indexes for read paths that had none (S5 closeout).
--
--    `ix_user_email` — the login lookup, `SELECT ... FROM user_account WHERE email = ?`
--    (app/admin/auth.ts). The only index on the column was `ux_user_email_global`, PARTIAL on
--    `tenant_id IS NULL`, so it served the fleet operator alone and every tenant admin login
--    scanned the table. This index is NON-UNIQUE ON PURPOSE: `Auth.authenticate()` refuses two
--    rows with one email as *ambiguous* and answers the same 401 as a wrong password, so the
--    response is not an oracle. A UNIQUE index would move that decision into SQLite — the
--    second tenant's INSERT would fail with a constraint error — and the ambiguity branch the
--    app is written around could never run. The index makes the lookup a seek; it does not
--    assert a rule the app owns.
--
--    `ix_domain_tenant` — the tenant's host list, `WHERE tenant_id = ... ORDER BY is_primary
--    DESC, host` (app/cli/export.ts). `ux_domain_primary` is partial on `is_primary = 1`, so a
--    listing scanned. The column order is the listing's own order, so the seek and the sort are
--    one index read and no temp b-tree.
--
--    Why the v4 delta and not a v5: `migrate` is version-gated, so a file already stamped v4
--    will not re-run this delta and keeps the old plan. There is no deployed v4 database this
--    repository knows of; if one appears before a v5 exists, the v5 delta must repeat these two
--    statements. An ungated `CREATE INDEX IF NOT EXISTS` in the runner would hide exactly the
--    divergence `comparePlanes` exists to catch, so there isn't one.
CREATE INDEX ix_user_email ON user_account(email);
CREATE INDEX ix_domain_tenant ON domain(tenant_id, is_primary DESC, host);

PRAGMA user_version = 4;
COMMIT;
PRAGMA foreign_keys = ON;
