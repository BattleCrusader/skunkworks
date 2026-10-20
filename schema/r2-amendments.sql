-- r2-amendments.sql — Data Model round-2 amendments to a tenant site.db.
--
-- Applies to a site.db at PRAGMA user_version = 1 (schema/site.sql) and yields user_version = 2.
-- Every statement here is exercised by scripts/model/verify_claims.py; nothing in this file is a
-- proposal that has not been run.
--
-- ORDER MATTERS. `PRAGMA foreign_keys` must be turned off OUTSIDE the transaction: inside one it is
-- a silent no-op (measured, R1 M3b). With the pragma on, DROP TABLE on a parent performs an implicit
-- DELETE and fires ON DELETE CASCADE on every child — a cms_page rebuild deletes every
-- cms_page_revision row (measured this round, check 5).
--
-- Two table rebuilds are unavoidable: SQLite cannot ALTER a CHECK constraint and cannot ADD a STORED
-- generated column. Both rebuilds carry sqlite_sequence forward (R1 M5: the counter resets to max(id)
-- otherwise, and reissued ids repoint audit rows and exported snapshots).

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

-- Carried across both rebuilds: DROP TABLE deletes the sqlite_sequence row and the rebuild recomputes
-- it from max(id), so a tenant that deleted its highest page would reissue that id (R1 M5).
CREATE TEMP TABLE _r2_seq AS SELECT name, seq FROM sqlite_sequence;

-- ---------------------------------------------------------------------------
-- A1. cms_page: accept '/', add rev + body_sha + managed_by, drop etag, rename css.
--
-- The shipped CHECK was `path NOT GLOB '*/'`, which rejects '/': in GLOB, `*` matches the empty
-- string, so '/' matches '*/'. The homepage — the one row every site must have — could not be
-- inserted. Found by building a fixture, not by a negative test.
--
-- `etag` is dropped rather than repaired: Runtime D-R8 sends `Cache-Control: no-store` on HTML and
-- defers 304, so the column had no reader. `body_sha` (sha256 over canon(body_html || body_css))
-- replaces it as the round-trip key (Runtime contract 3.6.1) and as the ETag source if 304 ever ships.
--
-- `managed_by` answers Red Team silence #5: once a designer hand-edits a page, the next person to
-- drag a block re-serialises the GrapesJS model and the hand edit disappears silently. A page the
-- editor does not own must not be opened by the editor.
-- ---------------------------------------------------------------------------
CREATE TABLE cms_page_r2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE COLLATE NOCASE
       CHECK(path = '/' OR (path GLOB '/*' AND path NOT GLOB '*..*' AND path NOT GLOB '*/'
             AND path NOT GLOB '*//*')),
  slug TEXT NOT NULL CHECK(slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','hidden')),
  template TEXT NOT NULL DEFAULT 'page' CHECK(template IN ('page','landing','post','index')),
  body_html TEXT NOT NULL DEFAULT '',
  body_css TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 0 CHECK(rev >= 0),
  body_sha TEXT NOT NULL DEFAULT '' CHECK(length(body_sha) IN (0, 64)),
  managed_by TEXT NOT NULL DEFAULT 'editor' CHECK(managed_by IN ('editor','hand')),
  seo_json TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER
);
INSERT INTO cms_page_r2 (id, path, slug, title, status, template, body_html, body_css,
                         seo_json, published_at, created_at, updated_at, updated_by)
     SELECT id, path, slug, title, status, template, body_html, css,
            seo_json, published_at, created_at, updated_at, updated_by FROM cms_page;
DROP TABLE cms_page;
ALTER TABLE cms_page_r2 RENAME TO cms_page;
CREATE INDEX ix_page_status ON cms_page(status, published_at);
UPDATE sqlite_sequence SET seq = COALESCE((SELECT seq FROM _r2_seq WHERE name = 'cms_page'), seq)
 WHERE name = 'cms_page';

-- ---------------------------------------------------------------------------
-- A2. cms_asset: storage_path becomes a generated column; add encrypted.
--
-- Red Team O5: storage_path is row data, a CRUD form exposes it, the symlink regenerator reads it,
-- so `../../../../etc/passwd` becomes a symlink in content/public and nginx serves it. A per-column
-- write policy in the CRUD generator is application code that can be forgotten. A generated column
-- is not writable by any statement, from any driver, including the sqlite3 CLI.
--
-- The path is a pure function of (sha256, mime), so nothing is lost: the column still reads.
-- ---------------------------------------------------------------------------
CREATE TABLE cms_asset_r2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(key = lower(key) AND length(key) BETWEEN 1 AND 96
      AND key NOT GLOB '*[^a-z0-9/_.-]*' AND key NOT GLOB '/?*' AND key NOT GLOB '*/'
      AND key NOT GLOB '*..*' AND key NOT GLOB '.?*'),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  kind TEXT NOT NULL CHECK(kind IN ('image','video','audio','document','archive')),
  access_class TEXT NOT NULL DEFAULT 'public' CHECK(access_class IN ('public','linked-private','gated')),
  storage_path TEXT GENERATED ALWAYS AS (
      'content/media/' || substr(sha256,1,2) || '/' || sha256 || '.' ||
      CASE mime WHEN 'image/webp' THEN 'webp' WHEN 'image/jpeg' THEN 'jpg'
                WHEN 'image/png'  THEN 'png'  WHEN 'image/avif' THEN 'avif'
                WHEN 'application/pdf' THEN 'pdf' WHEN 'video/mp4' THEN 'mp4'
                WHEN 'audio/mpeg' THEN 'mp3'  WHEN 'application/zip' THEN 'zip'
                ELSE 'bin' END) STORED,
  width INTEGER,
  height INTEGER,
  alt_text TEXT,
  caption TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0 CHECK(encrypted IN (0,1)),
  watermark_asset_id INTEGER REFERENCES cms_asset(id) ON DELETE SET NULL,
  watermark_spec_json TEXT,
  frozen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER,
  CHECK(kind <> 'image' OR (width IS NOT NULL AND height IS NOT NULL)),
  CHECK(watermark_asset_id IS NULL OR watermark_asset_id <> id),
  CHECK(access_class <> 'public' OR watermark_asset_id IS NULL)
);
INSERT INTO cms_asset_r2 (id, key, filename, mime, bytes, sha256, kind, access_class,
                          width, height, alt_text, caption, watermark_asset_id,
                          watermark_spec_json, frozen_at, created_at, created_by)
     SELECT id, key, filename, mime, bytes, sha256, kind, access_class,
            width, height, alt_text, caption, watermark_asset_id,
            watermark_spec_json, frozen_at, created_at, created_by FROM cms_asset;
DROP TABLE cms_asset;
ALTER TABLE cms_asset_r2 RENAME TO cms_asset;
CREATE INDEX ix_asset_sha ON cms_asset(sha256);
CREATE INDEX ix_asset_kind ON cms_asset(kind, created_at);
UPDATE sqlite_sequence SET seq = COALESCE((SELECT seq FROM _r2_seq WHERE name = 'cms_asset'), seq)
 WHERE name = 'cms_asset';

-- cms_asset_variant keeps its stored path: it is derived, but it is also the only record of which
-- variant files exist on disk, and a variant row whose file was deleted must be visible as such.

-- ---------------------------------------------------------------------------
-- A3. cms_download_event: accounting unit becomes the redemption, not the request.
--
-- Security DS-5 / Platform A1 / Red Team O8 measured the same defect from three directions: eight
-- Range requests spend eight uses. `jti` is the token's random id; `kind` says whether this row is
-- the first byte of a redemption, a continuation, or a denial. The partial unique index on
-- (jti) WHERE kind='first' is the dedupe gate — and it must be the FIRST write of the pair, because
-- the gate has to run before the counter (check 6: update-first spends 24 uses for one download).
--
-- `jti` is nullable on purpose: a denied attempt against an unknown code has no token yet, so a
-- NOT NULL column would make those rows unwritable. SQLite treats NULLs as distinct in a UNIQUE
-- index, so many pre-token rows coexist while a second 'first' for one jti is rejected (check 7).
--
-- bytes_sent is split. The app hands off with X-Accel-Redirect and never sees a byte (Security A-3),
-- so it can only record what it authorised; the sent count is nginx's $body_bytes_sent and is
-- ingested from the access log or the column stays NULL. A fabricated byte count is worse than none
-- in a chargeback.
-- ---------------------------------------------------------------------------
ALTER TABLE cms_download_event RENAME COLUMN bytes_sent TO bytes_declared;
ALTER TABLE cms_download_event ADD COLUMN bytes_sent INTEGER CHECK(bytes_sent IS NULL OR bytes_sent >= 0);
ALTER TABLE cms_download_event ADD COLUMN jti TEXT;
ALTER TABLE cms_download_event ADD COLUMN kind TEXT NOT NULL DEFAULT 'first'
      CHECK(kind IN ('first','range','denied'));
ALTER TABLE cms_download_event DROP COLUMN ranged;
CREATE UNIQUE INDEX ux_ev_jti_first ON cms_download_event(jti) WHERE kind = 'first';

-- ---------------------------------------------------------------------------
-- A4. cms_datasource: the publish-time cost stamp (Runtime contract 3.6.2 / D-R6).
--
-- Denormalised on purpose and listed as exception E5: the publish gate reads it on every publish and
-- an operator disputing a refusal needs the plan that produced it. Invalidated when the row count
-- doubles (a re-measure is mandatory before the next publish).
--
-- params_json declares which parameters a source accepts and which of them are route-bearing, so the
-- exporter can refuse a static bundle that would silently drop ?page=2 (Platform A5).
-- ---------------------------------------------------------------------------
ALTER TABLE cms_datasource ADD COLUMN cost_ms REAL;
ALTER TABLE cms_datasource ADD COLUMN cost_rows INTEGER;
ALTER TABLE cms_datasource ADD COLUMN cost_measured_at TEXT;
ALTER TABLE cms_datasource ADD COLUMN cost_plan TEXT;
ALTER TABLE cms_datasource ADD COLUMN params_json TEXT NOT NULL DEFAULT '[]'
      CHECK(json_valid(params_json) AND json_type(params_json) = 'array');

-- ---------------------------------------------------------------------------
-- A5. cms_trigger_registry, and the guards that do not depend on a connection pragma.
--
-- R1's DDL postcondition was "there are zero triggers". That was wrong twice: it forbade the only
-- in-database integrity mechanism that survives a foreign_keys=OFF connection (Security A-4, Red
-- Team O15), and it would have rejected any migration-owned trigger. The postcondition becomes
-- "every trigger is in this registry".
--
-- Guard 1 covers the three cms_* children whose FK is RESTRICT — the rows that represent a real
-- reference. Variants, watermark renders and aliases are derived and still CASCADE: a guard on a
-- derived row would make every image with a thumbnail undeletable, which is the kind of over-broad
-- constraint that gets dropped in a hurry. Guard 2 is generated per u_* table that has an ASSET
-- column (one trigger per table, named trg_asset_guard_u_<name>), and the DDL runner creates it in
-- the same transaction as the table. Both fire with foreign_keys OFF and from any driver, including
-- the sqlite3 CLI (check 12).
-- ---------------------------------------------------------------------------
CREATE TABLE cms_trigger_registry (
  name TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('asset_delete_guard','immutable_column','other')),
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER trg_cms_asset_delete_guard BEFORE DELETE ON cms_asset
WHEN EXISTS (SELECT 1 FROM cms_asset_link        WHERE asset_id = OLD.id)
  OR EXISTS (SELECT 1 FROM cms_asset_bundle_item WHERE asset_id = OLD.id)
  OR EXISTS (SELECT 1 FROM cms_download_code     WHERE asset_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'DM_E_ASSET_IN_USE');
END;
INSERT INTO cms_trigger_registry(name, table_name, purpose, checksum)
  VALUES ('trg_cms_asset_delete_guard','cms_asset','asset_delete_guard','v1');

-- The guard's EXISTS probes need a leading index; ux_link and ix_code_asset already lead on
-- asset_id, bundle_item does not.
CREATE INDEX ix_bundleitem_asset ON cms_asset_bundle_item(asset_id);

-- Immutability the schema must own, not the CRUD generator (Red Team O5): sha256 is the address and
-- the X-Accel-Redirect target; changing it points a page at different bytes. One trigger per column
-- because SQLite has no column-level CHECK that can compare OLD and NEW.
CREATE TRIGGER trg_cms_asset_sha_immutable BEFORE UPDATE OF sha256 ON cms_asset
WHEN NEW.sha256 IS NOT OLD.sha256
BEGIN
  SELECT RAISE(ABORT, 'DM_E_COLUMN_IMMUTABLE');
END;
INSERT INTO cms_trigger_registry(name, table_name, purpose, checksum)
  VALUES ('trg_cms_asset_sha_immutable','cms_asset','immutable_column','v1');

CREATE TRIGGER trg_cms_download_code_hash_immutable BEFORE UPDATE OF code_hash, code_lookup ON cms_download_code
WHEN NEW.code_hash IS NOT OLD.code_hash OR NEW.code_lookup IS NOT OLD.code_lookup
BEGIN
  SELECT RAISE(ABORT, 'DM_E_COLUMN_IMMUTABLE');
END;
INSERT INTO cms_trigger_registry(name, table_name, purpose, checksum)
  VALUES ('trg_cms_download_code_hash_immutable','cms_download_code','immutable_column','v1');

-- ---------------------------------------------------------------------------
-- A6. cms_redirect: the other path column, and the open redirect it allowed.
--
-- `from_path GLOB '/*'` had no `..` guard and no trailing-slash guard; `to_path GLOB '/*'` accepted
-- '//evil.example', which a browser resolves as a protocol-relative URL — an admin-form open redirect
-- on the client's own domain, the same class as Red Team O5 (a privileged form writing a
-- security-relevant value). Redirects are internal: an off-site link is cms_nav.href_kind='url',
-- which is visible as a link, not as a path.
-- ---------------------------------------------------------------------------
CREATE TABLE cms_redirect_r2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_path TEXT NOT NULL UNIQUE COLLATE NOCASE
       CHECK(from_path = '/' OR (from_path GLOB '/*' AND from_path NOT GLOB '*..*'
             AND from_path NOT GLOB '*/' AND from_path NOT GLOB '*//*')),
  to_path TEXT NOT NULL
       CHECK(to_path = '/' OR (to_path GLOB '/*' AND to_path NOT GLOB '//*'
             AND to_path NOT GLOB '*..*' AND to_path NOT GLOB '*/' AND to_path NOT GLOB '*//*')),
  status INTEGER NOT NULL DEFAULT 301 CHECK(status IN (301,302,308)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  hits INTEGER NOT NULL DEFAULT 0
);
INSERT INTO cms_redirect_r2 (id, from_path, to_path, status, created_at, hits)
     SELECT id, from_path, to_path, status, created_at, hits FROM cms_redirect;
DROP TABLE cms_redirect;
ALTER TABLE cms_redirect_r2 RENAME TO cms_redirect;
UPDATE sqlite_sequence SET seq = COALESCE((SELECT seq FROM _r2_seq WHERE name = 'cms_redirect'), seq)
 WHERE name = 'cms_redirect';

PRAGMA user_version = 2;

DROP TABLE _r2_seq;

COMMIT;

PRAGMA foreign_keys = ON;
