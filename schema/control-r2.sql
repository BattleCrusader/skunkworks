-- control-r2.sql — the v1 -> v2 delta for the control plane.
--
-- Applies to a control.db at PRAGMA user_version = 1 (the schema our fleet runs, schema/control.sql
-- as generated at commit cc1a5b4) and yields user_version = 2, which is the shape
-- schema/control.sql now generates.
--
-- The only structural change is C-21's anchor: one audit_seal row per tenant per UTC day. A fresh
-- bundle applies schema/control.sql and is already at v2 (C-24 — a bundle ships a seed, never
-- control.db); this file exists for an install that predates the seal.
--
-- `tenant.db_version` gains DEFAULT 3 in the new DDL. SQLite stores a column default in the table
-- text, so existing rows keep the old default until the table is rebuilt; that is harmless because
-- `migrate` writes db_version explicitly for every tenant it touches. No rebuild is performed for
-- a default nobody reads.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

CREATE TABLE audit_seal (
  tenant_key TEXT NOT NULL CHECK(length(tenant_key) BETWEEN 2 AND 40),
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  rows INTEGER NOT NULL CHECK(rows >= 0),
  head TEXT NOT NULL CHECK(length(head) = 64),
  sealed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_key, day)
);
CREATE INDEX ix_seal_day ON audit_seal(day);

-- C-24's seed carries one owner with must_change=1; the v1 schema had no such flag, so a seeded
-- user could not be forced to rotate the password install.sh printed.
ALTER TABLE user_account ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0
      CHECK(must_change IN (0,1));

PRAGMA user_version = 2;

COMMIT;

PRAGMA foreign_keys = ON;
