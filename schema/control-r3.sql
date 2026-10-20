-- control-r3.sql — the v2 -> v3 delta for the control plane (02-errata E-3).
--
-- Applies to a control.db at PRAGMA user_version = 2 (schema/control.sql v1 + schema/control-r2.sql
-- + the E-3 additions) and yields user_version = 3, which is the shape schema/control.sql now
-- generates. The convergence of this chain on schema/control.sql is asserted by
-- scripts/model/verify_claims.py check 20 and by test/migrate.test.ts.
--
-- WHY THIS EXISTS. §5.4's old stamp was `MAX(control_migration.id) || count(tenant)`. It could not
-- see an UPDATE (a status flip is an UPDATE), a mode flip, a db_version raise, or a `domain` row
-- deleted while the tenant count was unchanged — so §5.3 row 9 never fired at runtime and a deleted
-- host kept routing. The replacement is one revision row moved by six triggers on `tenant` and
-- `domain`.
--
-- TRIGGERS, NOT THE APPLICATION, because the write that suspends a tenant may come from `sqlite3`,
-- from `migrate`, or from the next image's admin tool, and the contract has to hold for all of them.
-- Each trigger runs in the same transaction as the write that fired it, so the counter and the row
-- it describes can never disagree.
--
-- `PRAGMA legacy_alter_table` is set by nobody: this file does not rename a table, and the tenant
-- chain's rename is kept honest by the trigger-drop order (E-6), not by a pragma.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE control_revision (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  rev INTEGER NOT NULL CHECK(rev >= 1),
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO control_revision(id, rev) VALUES (1, 1);

CREATE TRIGGER trg_tenant_rev_insert AFTER INSERT ON tenant
BEGIN
  UPDATE control_revision SET rev = rev + 1, changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1;
END;

CREATE TRIGGER trg_tenant_rev_update AFTER UPDATE ON tenant
BEGIN
  UPDATE control_revision SET rev = rev + 1, changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1;
END;

CREATE TRIGGER trg_tenant_rev_delete AFTER DELETE ON tenant
BEGIN
  UPDATE control_revision SET rev = rev + 1, changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1;
END;

CREATE TRIGGER trg_domain_rev_insert AFTER INSERT ON domain
BEGIN
  UPDATE control_revision SET rev = rev + 1, changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1;
END;

CREATE TRIGGER trg_domain_rev_update AFTER UPDATE ON domain
BEGIN
  UPDATE control_revision SET rev = rev + 1, changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1;
END;

CREATE TRIGGER trg_domain_rev_delete AFTER DELETE ON domain
BEGIN
  UPDATE control_revision SET rev = rev + 1, changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1;
END;

PRAGMA user_version = 3;

COMMIT;

PRAGMA foreign_keys = ON;
