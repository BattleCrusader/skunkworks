-- r6-amendments.sql — the v5 -> v6 delta for a tenant site.db.
--
-- Applies to a site.db at PRAGMA user_version = 5 and yields user_version = 6, which is the
-- shape schema/site.sql now generates. The convergence of this chain on schema/site.sql is
-- asserted by scripts/model/verify_claims.py check 20 (table set, column set, trigger set, index
-- set and the canonical table text), so the two artefacts cannot drift without `make test`
-- failing.
--
-- WHAT THIS ADDS AND WHY (02-errata E-49)
--
--   `cms_css_blob` — a stylesheet as a row, named by its own sha256.
--
--   A page's CSS used to travel inside the document as `<style>`, which the site's CSP
--   (`style-src 'self'`, no inline allowance) makes a browser block. The bytes were in the
--   markup and dead in the browser: curl saw the styling, the visitor did not (E-41 measured the
--   same class of defect for the theme). Serving them from this origin is allowed by the policy
--   as it stands, but a stylesheet that must never be revalidated needs a URL that names its
--   bytes — otherwise every navigation pays a conditional request in front of the first paint
--   (E-48). Hence a blob: `/_css/<sha256>.css` is immutable by construction, two pages that share
--   a sheet share a file, and an export writes exactly the files its documents point at.
--
--   `cms_theme` — an uploaded look, one of which may be active.
--
--   The theme used to be a text field on the Site screen. That is a settings blob, not a theme:
--   it cannot be kept, swapped, previewed or rolled back. A row per upload, with the CSS in the
--   blob table, gives all four, and `cms_settings.site.theme_key` names the active one — a single
--   value, so "only one theme is enabled at a time" is a property of the model rather than a rule
--   someone has to remember. An empty/absent pointer falls back to the pasted `site.theme_css`,
--   which is what a tenant seeded by an older image has.
CREATE TABLE cms_css_blob (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
  css TEXT NOT NULL CHECK(length(css) BETWEEN 1 AND 1048576),
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ix_ccb_created ON cms_css_blob(created_at);

CREATE TABLE cms_theme (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_key TEXT NOT NULL UNIQUE CHECK(theme_key GLOB '[a-z0-9][a-z0-9-]*' AND length(theme_key) BETWEEN 2 AND 64),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  css_sha256 TEXT NOT NULL REFERENCES cms_css_blob(sha256),
  source_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER
);
CREATE INDEX ix_ct_created ON cms_theme(created_at);

PRAGMA user_version = 6;
