-- r3-amendments.sql — the v2 -> v3 delta for a tenant site.db.
--
-- Applies to a site.db at PRAGMA user_version = 2 (schema/site.sql v1 + schema/r2-amendments.sql)
-- and yields user_version = 3, which is the shape schema/site.sql now generates. The convergence
-- of this chain on schema/site.sql is asserted by scripts/model/verify_claims.py check 20: table
-- set, column set per table, trigger set and registry rows are compared, so the two artefacts
-- cannot drift without make test failing.
--
-- WHAT THIS FILE IS, PER THE REGISTER
--   Section A1 is C-6's delta and is exactly the three statements §4.4 names: rename
--   code_lookup -> code_selector, rebuild cms_download_code to replace the length-64 CHECK with
--   CHECK(length(code_selector) = 4), and replace the immutability trigger so it covers both
--   columns. Sections A2-A9 carry the rest of the register's DDL deltas (C-4, C-5, C-7, C-13,
--   C-14, C-16, C-21, C-23, O-34, O-36, O-44). A1 is the minimum the register demands; A2-A9 are
--   what the register demands in total.
--
-- ORDER MATTERS, and it is the same discipline r2-amendments documents:
--   * PRAGMA foreign_keys is set OUTSIDE the transaction — inside one it is a silent no-op (check 6).
--   * With the pragma ON, DROP TABLE on a parent implicitly deletes children and fires CASCADE:
--     rebuilding cms_page would delete every cms_page_revision row (check 13).
--   * Every rebuild carries sqlite_sequence forward inside the transaction, or a tenant that
--     deleted its highest row gets that id reissued (check 5).
--
-- MIGRATION HAZARDS, STATED NOT HIDDEN
--   * cms_page gains the I8 body ban as a CHECK. A v2 page whose stored body_html contains
--     <script, <style, <!--, javascript: or srcdoc cannot be copied and aborts this migration
--     for THAT TENANT ONLY: `migrate` exits 0 with a per-tenant report (C-10), the tenant serves
--     503 SKW_E_DM_SCHEMA_STALE, and an operator resolves the page. No content is rewritten
--     silently — a page that was hand-edited with a script is a decision, not a typo.
--   * cms_download_code gains CHECK(code_hash GLOB '$argon2id$*'). A v2 row holding a non-argon2id
--     value aborts the same way and for the same reason: a code table whose hashes are not what
--     the design says cannot be migrated honestly.
--   * A v2 database with any cms_download_code row refuses to migrate (see the precondition
--     below). The product has never issued a code; a fleet that somehow has one needs the reissue
--     path, not a guess.
--   * Rebuilding cms_download_event copies the event table once. It is append-only, so the copy
--     is sequential; the rebuild exists to remove the DEFAULT 0 on bytes_declared (a default that
--     would let an INSERT write a byte count nobody observed, C-14).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

-- PRECONDITION, and it is a refusal rather than a rewrite: a v2 access code is 12 characters
-- stored as HMAC(code_lookup) + argon2id. The v3 row needs a 4-character plaintext selector, and no
-- function of an HMAC yields the first four characters of a code nobody can read back. Revoking or
-- re-selecting those rows silently would either kill a buyer's download without telling anyone or
-- invent a selector that can never match. So: a tenant that has issued codes does not migrate in
-- place. `migrate` reports it, the tenant serves 503 SKW_E_DM_SCHEMA_STALE (C-10), and an operator
-- reissues (one audited action: revoke + mint + send, O-28). The constraint name is the message.
CREATE TEMP TABLE _r3_codes_must_be_empty (
  n INTEGER CONSTRAINT legacy_12_char_codes_have_no_v3_selector CHECK(n = 0));
INSERT INTO _r3_codes_must_be_empty SELECT count(*) FROM cms_download_code;

CREATE TEMP TABLE _r3_seq AS SELECT name, seq FROM sqlite_sequence;

-- ===========================================================================
-- A1. C-6 — access-code storage: selector + argon2, no pepper. Three statements.
-- ===========================================================================

-- (1) the rename. The 64-hex HMAC column becomes a 4-character plaintext selector; there is no
--     pepper, so nothing has to travel, rotate, or be protected beyond the argon2 hash.
ALTER TABLE cms_download_code RENAME COLUMN code_lookup TO code_selector;

-- (2) the rebuild. SQLite cannot ALTER a CHECK, and the shipped one demanded length 64. The new
--     one is the register's exact predicate. code_hash is additionally constrained to an argon2id
--     PHC string so a plaintext code cannot be stored by a future mistake.
CREATE TABLE cms_download_code_r3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_selector TEXT NOT NULL UNIQUE CHECK(length(code_selector) = 4),
  code_hash TEXT NOT NULL CHECK(code_hash GLOB '$argon2id$*'),
  asset_id INTEGER REFERENCES cms_asset(id) ON DELETE RESTRICT,
  bundle_id INTEGER REFERENCES cms_asset_bundle(id) ON DELETE RESTRICT,
  max_uses INTEGER CHECK(max_uses IS NULL OR max_uses BETWEEN 1 AND 100),
  uses INTEGER NOT NULL DEFAULT 0 CHECK(uses >= 0),
  expires_at TEXT,
  issued_to_email TEXT,
  order_ref TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((asset_id IS NULL) <> (bundle_id IS NULL))
);
INSERT INTO cms_download_code_r3 (id, code_selector, code_hash, asset_id, bundle_id, max_uses,
                                  uses, expires_at, issued_to_email, order_ref, revoked_at,
                                  last_used_at, created_at)
     SELECT id, code_selector, code_hash, asset_id, bundle_id, max_uses,
            uses, expires_at, issued_to_email, order_ref, revoked_at,
            last_used_at, created_at FROM cms_download_code;

-- (2b) THE TRIGGER DROPS COME BEFORE THE DROP TABLE (E-6). SQLite >= 3.25 re-parses
--      every trigger when a table is renamed, so a trigger whose body or ON clause names
--      cms_download_code aborts `ALTER TABLE cms_download_code_r3 RENAME TO cms_download_code`
--      with "no such table: main.cms_download_code". Both v2 triggers are dropped here and
--      recreated verbatim in A9; `legacy_alter_table` is set by nobody.
DROP TRIGGER IF EXISTS trg_cms_asset_delete_guard;
DROP TRIGGER IF EXISTS trg_cms_download_code_hash_immutable;

DROP TABLE cms_download_code;
ALTER TABLE cms_download_code_r3 RENAME TO cms_download_code;
CREATE INDEX ix_code_asset ON cms_download_code(asset_id, created_at);
UPDATE sqlite_sequence SET seq = COALESCE((SELECT seq FROM _r3_seq WHERE name = 'cms_download_code'), seq)
 WHERE name = 'cms_download_code';

-- (3) the immutability trigger, now covering both columns. Dropped and recreated in A9 with the
--     rest of the trigger set, because every RAISE message moves to the SKW_E_ taxonomy (C-19).

-- ===========================================================================
-- A2. C-7 / C-14 — cms_download_event: bytes_declared has no default, jti is nullable.
-- ===========================================================================
CREATE TABLE cms_download_event_r3 (
  id INTEGER PRIMARY KEY,
  code_id INTEGER REFERENCES cms_download_code(id) ON DELETE SET NULL,
  asset_id INTEGER REFERENCES cms_asset(id) ON DELETE SET NULL,
  jti TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('first','range','denied')),
  bytes_declared INTEGER NOT NULL CHECK(bytes_declared >= 0),
  bytes_sent INTEGER CHECK(bytes_sent IS NULL OR bytes_sent >= 0),
  ip_hash TEXT,
  ua_hash TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok','denied_quota','denied_expired','denied_revoked','denied_token','denied_watermark')),
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO cms_download_event_r3 (id, code_id, asset_id, jti, kind, bytes_declared, bytes_sent,
                                   ip_hash, ua_hash, outcome, ts)
     SELECT id, code_id, asset_id, jti, kind, bytes_declared, bytes_sent,
            ip_hash, ua_hash, outcome, ts FROM cms_download_event;
DROP TABLE cms_download_event;
ALTER TABLE cms_download_event_r3 RENAME TO cms_download_event;
CREATE INDEX ix_ev_code_ts ON cms_download_event(code_id, ts);
CREATE INDEX ix_ev_ts ON cms_download_event(ts);
CREATE UNIQUE INDEX ux_ev_jti_first ON cms_download_event(jti) WHERE kind = 'first';

-- ===========================================================================
-- A3. C-23 / C-12 — cms_page: template becomes a slug, body gets the I8 ban.
-- ===========================================================================
CREATE TABLE cms_page_r3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE COLLATE NOCASE
       CHECK(path = '/' OR (path GLOB '/*' AND path NOT GLOB '*..*' AND path NOT GLOB '*/'
             AND path NOT GLOB '*//*')),
  slug TEXT NOT NULL CHECK(slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','hidden')),
  template TEXT NOT NULL DEFAULT 'page' CHECK(template GLOB '[a-z][a-z0-9-]*'),
  body_html TEXT NOT NULL DEFAULT ''
       CHECK(body_html NOT LIKE '%<script%' AND body_html NOT LIKE '%<style%'
             AND body_html NOT LIKE '%<!--%' AND body_html NOT LIKE '%javascript:%'
             AND body_html NOT LIKE '%srcdoc%'),
  body_css TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 0 CHECK(rev >= 0),
  body_sha TEXT NOT NULL DEFAULT '' CHECK(length(body_sha) IN (0,64)),
  managed_by TEXT NOT NULL DEFAULT 'editor' CHECK(managed_by IN ('editor','hand')),
  seo_json TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER
);
INSERT INTO cms_page_r3 (id, path, slug, title, status, template, body_html, body_css, rev,
                         body_sha, managed_by, seo_json, published_at, created_at, updated_at,
                         updated_by)
     SELECT id, path, slug, title, status, template, body_html, body_css, rev,
            body_sha, managed_by, seo_json, published_at, created_at, updated_at, updated_by
       FROM cms_page;
DROP TABLE cms_page;
ALTER TABLE cms_page_r3 RENAME TO cms_page;
CREATE INDEX ix_page_status ON cms_page(status, published_at);
UPDATE sqlite_sequence SET seq = COALESCE((SELECT seq FROM _r3_seq WHERE name = 'cms_page'), seq)
 WHERE name = 'cms_page';

-- ===========================================================================
-- A4. C-13 — cms_table_registry: class + prefix agreement, closed-type inventory.
-- ===========================================================================
CREATE TABLE cms_table_registry_r3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL UNIQUE CHECK(table_name GLOB 'u_?*' OR table_name GLOB 'p_?*'),
  table_class TEXT NOT NULL CHECK(table_class IN ('user','plugin')),
  plugin_id TEXT CHECK(plugin_id IS NULL OR (plugin_id GLOB '[a-z][a-z0-9]*' AND length(plugin_id) BETWEEN 2 AND 20)),
  ddl_version INTEGER NOT NULL DEFAULT 1 CHECK(ddl_version >= 1),
  column_count INTEGER NOT NULL CHECK(column_count BETWEEN 1 AND 40),
  index_count INTEGER NOT NULL DEFAULT 0 CHECK(index_count BETWEEN 0 AND 8),
  columns_json TEXT NOT NULL CHECK(json_valid(columns_json) AND json_type(columns_json) = 'array'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER,
  notes TEXT,
  CHECK((table_class = 'user' AND table_name GLOB 'u_?*' AND plugin_id IS NULL)
     OR (table_class = 'plugin' AND table_name GLOB 'p_?*' AND plugin_id IS NOT NULL))
);
-- Existing rows can only be u_* (the v2 CHECK demanded it), so class 'user' is a fact, not a guess.
-- columns_json is the one field the migration cannot recover in SQL (it needs PRAGMA table_info);
-- the app refreshes the inventory the next time it alters the table. column_count is preserved.
INSERT INTO cms_table_registry_r3 (id, table_name, table_class, plugin_id, ddl_version,
                                   column_count, index_count, columns_json, created_at,
                                   created_by, notes)
     SELECT id, table_name, 'user', NULL, ddl_version,
            column_count, 0, '[]', created_at, created_by, notes
       FROM cms_table_registry;
DROP TABLE cms_table_registry;
ALTER TABLE cms_table_registry_r3 RENAME TO cms_table_registry;
CREATE INDEX ix_tbl_class ON cms_table_registry(table_class, plugin_id);
UPDATE sqlite_sequence SET seq = COALESCE((SELECT seq FROM _r3_seq WHERE name = 'cms_table_registry'), seq)
 WHERE name = 'cms_table_registry';

-- ===========================================================================
-- A4b. cms_page_revision follows cms_page: `css` becomes `body_css` and the revision records the
--      page rev it snapshotted. Two ALTERs, not a rebuild: this is the second-largest table in a
--      tenant file and neither change needs the 12-step procedure.
-- ===========================================================================
ALTER TABLE cms_page_revision RENAME COLUMN css TO body_css;
ALTER TABLE cms_page_revision ADD COLUMN rev INTEGER NOT NULL DEFAULT 0 CHECK(rev >= 0);

-- ===========================================================================
-- A5. C-18 / O-14 — cms_datasource: aggregates are grammar, the gate reads max.
-- ===========================================================================
ALTER TABLE cms_datasource RENAME COLUMN cost_ms TO cost_ms_p95;
ALTER TABLE cms_datasource ADD COLUMN cost_ms_max REAL
      CHECK(cost_ms_max IS NULL OR cost_ms_max >= 0);
ALTER TABLE cms_datasource ADD COLUMN aggregate_json TEXT
      CHECK(aggregate_json IS NULL OR (json_valid(aggregate_json) AND json_type(aggregate_json) = 'object'));
ALTER TABLE cms_datasource ADD COLUMN group_by_json TEXT
      CHECK(group_by_json IS NULL OR (json_valid(group_by_json) AND json_type(group_by_json) = 'array'));

-- ===========================================================================
-- A6. C-16 — cms_watermark_render: every render has a death date.
-- ===========================================================================
-- The epoch default exists only because SQLite demands a non-NULL default on ALTER ADD NOT NULL.
-- A legacy row is therefore due for deletion on the next sweep, which is the correct answer: a
-- render whose token expired before this migration has no continuation to serve.
ALTER TABLE cms_watermark_render ADD COLUMN expires_at TEXT NOT NULL
      DEFAULT '1970-01-01T00:00:00.000Z';
CREATE INDEX ix_wm_expiry ON cms_watermark_render(expires_at);

-- ===========================================================================
-- A7. C-21 — cms_audit: the chain columns. Rows before v3 are unchained (prev_hash='').
-- ===========================================================================
ALTER TABLE cms_audit ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''
      CHECK(length(prev_hash) IN (0,64));
ALTER TABLE cms_audit ADD COLUMN hash TEXT NOT NULL DEFAULT ''
      CHECK(length(hash) IN (0,64));

-- ===========================================================================
-- A8. C-4 / C-5 / O-34 / O-44 — the new tables.
-- ===========================================================================
CREATE TABLE cms_component_registry (
  name TEXT PRIMARY KEY CHECK(name GLOB '[a-z][a-z0-9-]*' AND length(name) BETWEEN 2 AND 40),
  kind TEXT NOT NULL CHECK(kind IN ('block','shell','island','list')),
  renderer TEXT NOT NULL CHECK(renderer GLOB 'components/*' OR renderer GLOB 'islands/*'),
  repeat_child TEXT,
  bindings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(bindings_json) AND json_type(bindings_json) = 'array'),
  props_schema_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(props_schema_json) AND json_type(props_schema_json) = 'object'),
  limit_max INTEGER,
  version TEXT NOT NULL,
  CHECK(kind <> 'list' OR (repeat_child IS '[data-repeat]' AND limit_max IS NOT NULL)),
  CHECK(kind = 'list' OR repeat_child IS NULL),
  CHECK(limit_max IS NULL OR limit_max BETWEEN 1 AND 200)
);
CREATE INDEX ix_comp_kind ON cms_component_registry(kind);

CREATE TABLE cms_download_code_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL REFERENCES cms_download_code(id) ON DELETE CASCADE,
  pruned_through TEXT NOT NULL,
  uses INTEGER NOT NULL CHECK(uses >= 0),
  first_events INTEGER NOT NULL CHECK(first_events >= 0),
  range_events INTEGER NOT NULL DEFAULT 0 CHECK(range_events >= 0),
  archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ix_archive_code ON cms_download_code_archive(code_id, pruned_through);

CREATE TABLE cms_plugin_installed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL UNIQUE CHECK(plugin_id GLOB '[a-z][a-z0-9]*' AND length(plugin_id) BETWEEN 2 AND 20),
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  root_hash TEXT NOT NULL CHECK(length(root_hash) = 64),
  publisher TEXT NOT NULL,
  publisher_key_fingerprint TEXT,
  signature_state TEXT NOT NULL CHECK(signature_state IN ('first_party','imported','unsigned')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  test_report_sha TEXT,
  runner_image_digest TEXT,
  installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  enabled_at TEXT,
  CHECK(publisher_key_fingerprint IS NULL OR length(publisher_key_fingerprint) BETWEEN 16 AND 128),
  CHECK(enabled = 0 OR test_report_sha IS NOT NULL)
);
CREATE INDEX ix_plugin_enabled ON cms_plugin_installed(enabled);

CREATE TABLE cms_plugin_migration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL CHECK(plugin_id GLOB '[a-z][a-z0-9]*'),
  version TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq >= 1),
  checksum TEXT NOT NULL,
  duration_ms INTEGER,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ux_plugin_mig UNIQUE(plugin_id, version, seq)
);

CREATE TABLE cms_plugin_setting (
  plugin_id TEXT NOT NULL REFERENCES cms_plugin_installed(plugin_id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK(key GLOB '[a-z][a-z0-9._-]*'),
  value_json TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('string','int','bool','json','secret')),
  secret INTEGER NOT NULL DEFAULT 0 CHECK(secret IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER,
  PRIMARY KEY(plugin_id, key),
  CHECK((type = 'secret') = (secret = 1))
);

CREATE TABLE cms_plugin_revoked (
  root_hash TEXT PRIMARY KEY CHECK(length(root_hash) = 64),
  plugin_id TEXT NOT NULL,
  reason TEXT,
  revoked_by INTEGER,
  revoked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- cms_trigger_registry gains the lookup index the "is every trigger registered" postcondition uses.
CREATE INDEX ix_trg_table ON cms_trigger_registry(table_name);

-- ===========================================================================
-- A8b. Three v2 constraint drifts the old name-set convergence check could not see
--      (02-errata E-14). Each is a CHECK the shipped v3 DDL has and the v1+r2 chain did not:
--        * cms_redirect.from_path lacked `NOT GLOB '//*'` (O-16's shared path predicate);
--        * cms_form_submission.state lacked the 'suppressed' outcome (O-30's honeypot);
--        * cms_datasource.cost_ms_p95 lost the `>= 0` CHECK, because v2's cost_ms never had one
--          and A5's RENAME COLUMN carries the old column definition forward.
--      SQLite cannot ALTER a CHECK, so each is the 12-step rebuild. No table references any of
--      the three, so DROP TABLE cascades nothing. The column lists are explicit.
-- ===========================================================================
CREATE TABLE cms_redirect_r3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_path TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(from_path = '/' OR (from_path GLOB '/*' AND from_path NOT GLOB '//*' AND from_path NOT GLOB '*..*' AND from_path NOT GLOB '*/' AND from_path NOT GLOB '*//*')),
  to_path TEXT NOT NULL CHECK(to_path = '/' OR (to_path GLOB '/*' AND to_path NOT GLOB '//*' AND to_path NOT GLOB '*..*' AND to_path NOT GLOB '*/' AND to_path NOT GLOB '*//*')),
  status INTEGER NOT NULL DEFAULT 301 CHECK(status IN (301,302,308)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  hits INTEGER NOT NULL DEFAULT 0
);
INSERT INTO cms_redirect_r3 (id, from_path, to_path, status, created_at, hits)
     SELECT id, from_path, to_path, status, created_at, hits FROM cms_redirect;
DROP TABLE cms_redirect;
ALTER TABLE cms_redirect_r3 RENAME TO cms_redirect;
UPDATE sqlite_sequence SET seq = COALESCE((SELECT seq FROM _r3_seq WHERE name = 'cms_redirect'), seq)
 WHERE name = 'cms_redirect';

CREATE TABLE cms_form_submission_r3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL REFERENCES cms_form(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  ip_hash TEXT,
  spam_score REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'new' CHECK(state IN ('new','read','spam','forwarded','suppressed')),
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO cms_form_submission_r3 (id, form_id, payload_json, ip_hash, spam_score, state, ts)
     SELECT id, form_id, payload_json, ip_hash, spam_score, state, ts FROM cms_form_submission;
DROP TABLE cms_form_submission;
ALTER TABLE cms_form_submission_r3 RENAME TO cms_form_submission;
CREATE INDEX ix_sub_form_ts ON cms_form_submission(form_id, ts);
UPDATE sqlite_sequence SET seq = COALESCE((SELECT seq FROM _r3_seq WHERE name = 'cms_form_submission'), seq)
 WHERE name = 'cms_form_submission';

CREATE TABLE cms_datasource_r3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(key = lower(key) AND key NOT GLOB '*[^a-z0-9-]*'),
  kind TEXT NOT NULL CHECK(kind IN ('view','query')),
  spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
  aggregate_json TEXT CHECK(aggregate_json IS NULL OR (json_valid(aggregate_json) AND json_type(aggregate_json) = 'object')),
  group_by_json TEXT CHECK(group_by_json IS NULL OR (json_valid(group_by_json) AND json_type(group_by_json) = 'array')),
  params_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(params_json) AND json_type(params_json) = 'array'),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1)),
  ttl_s INTEGER NOT NULL DEFAULT 60 CHECK(ttl_s BETWEEN 0 AND 86400),
  cost_ms_p95 REAL CHECK(cost_ms_p95 IS NULL OR cost_ms_p95 >= 0),
  cost_ms_max REAL CHECK(cost_ms_max IS NULL OR cost_ms_max >= 0),
  cost_rows INTEGER,
  cost_measured_at TEXT,
  cost_plan TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at TEXT,
  published_by INTEGER
);
INSERT INTO cms_datasource_r3 (id, key, kind, spec_json, aggregate_json, group_by_json, params_json,
                               is_public, ttl_s, cost_ms_p95, cost_ms_max, cost_rows,
                               cost_measured_at, cost_plan, created_at, published_at, published_by)
     SELECT id, key, kind, spec_json, aggregate_json, group_by_json, params_json,
            is_public, ttl_s, cost_ms_p95, cost_ms_max, cost_rows,
            cost_measured_at, cost_plan, created_at, published_at, published_by FROM cms_datasource;
DROP TABLE cms_datasource;
ALTER TABLE cms_datasource_r3 RENAME TO cms_datasource;
CREATE INDEX ix_ds_public ON cms_datasource(is_public);
UPDATE sqlite_sequence SET seq = COALESCE((SELECT seq FROM _r3_seq WHERE name = 'cms_datasource'), seq)
 WHERE name = 'cms_datasource';

-- ===========================================================================
-- A9. C-19 — every RAISE message moves to the SKW_E_ taxonomy, and every trigger is registered.
--     The three v2 triggers are dropped (the two that name cms_download_code already in A1, E-6)
--     and recreated because their message changed from DM_E_<NAME> to SKW_E_DM_<NAME>; the two
--     audit triggers are new in v3.
-- ===========================================================================
DROP TRIGGER IF EXISTS trg_cms_asset_delete_guard;
DROP TRIGGER IF EXISTS trg_cms_asset_sha_immutable;
DROP TRIGGER IF EXISTS trg_cms_download_code_hash_immutable;
DELETE FROM cms_trigger_registry
 WHERE name IN ('trg_cms_asset_delete_guard','trg_cms_asset_sha_immutable',
                'trg_cms_download_code_hash_immutable');

CREATE TRIGGER trg_cms_asset_delete_guard BEFORE DELETE ON cms_asset
WHEN EXISTS (SELECT 1 FROM cms_asset_link        WHERE asset_id = OLD.id)
  OR EXISTS (SELECT 1 FROM cms_asset_bundle_item WHERE asset_id = OLD.id)
  OR EXISTS (SELECT 1 FROM cms_download_code     WHERE asset_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_DM_ASSET_IN_USE');
END;
INSERT INTO cms_trigger_registry(name, table_name, purpose, checksum)
  VALUES ('trg_cms_asset_delete_guard', 'cms_asset', 'asset_delete_guard', 'v3');

CREATE TRIGGER trg_cms_asset_sha_immutable BEFORE UPDATE OF sha256 ON cms_asset
WHEN NEW.sha256 IS NOT OLD.sha256
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_DM_COLUMN_IMMUTABLE');
END;
INSERT INTO cms_trigger_registry(name, table_name, purpose, checksum)
  VALUES ('trg_cms_asset_sha_immutable', 'cms_asset', 'immutable_column', 'v3');

CREATE TRIGGER trg_cms_download_code_hash_immutable BEFORE UPDATE OF code_hash, code_selector ON cms_download_code
WHEN NEW.code_hash IS NOT OLD.code_hash OR NEW.code_selector IS NOT OLD.code_selector
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_DM_COLUMN_IMMUTABLE');
END;
INSERT INTO cms_trigger_registry(name, table_name, purpose, checksum)
  VALUES ('trg_cms_download_code_hash_immutable', 'cms_download_code', 'immutable_column', 'v3');

CREATE TRIGGER trg_cms_audit_append_only BEFORE UPDATE ON cms_audit
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_DM_COLUMN_IMMUTABLE');
END;
INSERT INTO cms_trigger_registry(name, table_name, purpose, checksum)
  VALUES ('trg_cms_audit_append_only', 'cms_audit', 'immutable_column', 'v3');

CREATE TRIGGER trg_cms_audit_no_delete BEFORE DELETE ON cms_audit
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_DM_COLUMN_IMMUTABLE');
END;
INSERT INTO cms_trigger_registry(name, table_name, purpose, checksum)
  VALUES ('trg_cms_audit_no_delete', 'cms_audit', 'immutable_column', 'v3');

PRAGMA user_version = 3;

DROP TABLE _r3_seq;

COMMIT;

PRAGMA foreign_keys = ON;
