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

PRAGMA user_version = 4;
COMMIT;
PRAGMA foreign_keys = ON;
