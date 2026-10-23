-- r7-amendments.sql — the v6 -> v7 delta for a tenant site.db.
--
-- Applies to a site.db at PRAGMA user_version = 6 and yields user_version = 7, which is the shape
-- schema/site.sql now generates. The convergence of this chain on schema/site.sql is asserted by
-- scripts/model/verify_claims.py check 20 (table set, column set, trigger set, index set and the
-- canonical table text), so the two artefacts cannot drift without `make test` failing.
--
-- WHAT THIS ADDS AND WHY (02-errata E-54)
--
--   `cms_theme_asset` — the pictures and faces a theme's rules name.
--
--   A theme was one stylesheet, which is enough for rules and not enough for a look: a header with
--   a logo, a hero with a photograph, a display face instead of a web-safe stack. Those bytes have
--   to live somewhere the site can serve them and the export can copy them, so they live on disk
--   beside the tenant (`tenants/<key>/theme-assets/<theme_key>/<path>`) and this table is the link
--   the renderer follows. The row is what makes a URL possible: `path` and `sha256` together mean a
--   served asset URL can be immutable (`?v=<sha8>`) and an export writes exactly the files its
--   documents point at, which is the same rule `/_css/<sha>.css` already follows for stylesheets.
--
--   Nothing existing is touched: one CREATE TABLE, one CREATE INDEX, and the theme rows a tenant
--   already has simply have no assets. That is why this is an amendment and not a rebuild.
CREATE TABLE cms_theme_asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_id INTEGER NOT NULL REFERENCES cms_theme(id),
  path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 200 AND substr(path,1,1) <> '/' AND path NOT GLOB '*..*'),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  content_type TEXT NOT NULL CHECK(length(content_type) BETWEEN 3 AND 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT uq_cta_path UNIQUE(theme_id, path)
);
CREATE INDEX ix_cta_theme ON cms_theme_asset(theme_id);

PRAGMA user_version = 7;
