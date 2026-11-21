-- r12 — a plugin setting can be a time, a choice or an address.
--
-- Why this is a rebuild and not an ALTER: the vocabulary was a CHECK constraint on the column, and
-- SQLite cannot widen a CHECK in place. It is also the honest shape of the change — the constraint
-- is what stopped `contact` asking "when?" as a time, so widening it *is* the migration.
--
-- Nothing references `cms_plugin_setting` (it references `cms_plugin_installed`), so the drop cannot
-- cascade and the rename cannot break a foreign key that points at it. Every row is copied verbatim:
-- the seven columns, in order, including `secret`, because `CHECK((type = 'secret') = (secret = 1))`
-- has to keep holding for the writes that already happened.
--
-- `PRAGMA legacy_alter_table` is deliberately untouched: the only ALTER is the rename of a table
-- nothing points at, and turning the flag on is how a rename quietly stops rewriting references.

CREATE TABLE cms_plugin_setting_r12 (
  plugin_id TEXT NOT NULL REFERENCES cms_plugin_installed(plugin_id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK(key GLOB '[a-z][a-z0-9._-]*'),
  value_json TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('string','int','bool','json','secret','time','select','email')),
  secret INTEGER NOT NULL DEFAULT 0 CHECK(secret IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER,
  PRIMARY KEY(plugin_id, key),
  CHECK((type = 'secret') = (secret = 1))
);

INSERT INTO cms_plugin_setting_r12 (plugin_id, key, value_json, type, secret, updated_at, updated_by)
  SELECT plugin_id, key, value_json, type, secret, updated_at, updated_by FROM cms_plugin_setting;

DROP TABLE cms_plugin_setting;

ALTER TABLE cms_plugin_setting_r12 RENAME TO cms_plugin_setting;

PRAGMA user_version = 12;
