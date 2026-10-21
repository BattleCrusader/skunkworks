-- r5-amendments.sql — the v4 -> v5 delta for a tenant site.db.
--
-- Applies to a site.db at PRAGMA user_version = 4 (schema/site.sql v4, or v1 + r2 + r3 + r4) and
-- yields user_version = 5, which is the shape schema/site.sql now generates. The convergence of
-- this chain on schema/site.sql is asserted by scripts/model/verify_claims.py check 20: table
-- set, column set per table, trigger set, index set and the canonical table text (CHECK
-- constraints included) are compared, so the two artefacts cannot drift without `make test`
-- failing.
--
-- WHAT THIS ADDS AND WHY (02-errata E-35)
--
--   `cms_page.draft_html`, `draft_css`, `draft_sha`, `draft_updated_at`.
--
--   Before this, one row held one body: `savePage` wrote the canvas bytes into `body_html` and
--   flipped `status` to 'draft' in the same statement, so opening a LIVE page in the editor and
--   pressing Save took the page off the site — a 404 on a URL that had answered a second
--   earlier. The operator's report was exact and the cause was structural: one body, two
--   audiences.
--
--   Now `body_*` is the published body (the renderer reads it; only publish writes it) and
--   `draft_*` is the work in progress (only the editor writes it). `status` keeps its three
--   values and its meaning: a published page is still published while you edit it, because it
--   still is.
--
--   Four columns on the existing row, not a second table: a `cms_page_draft` table would need
--   its own lifecycle, its own orphan sweep, its own delete behaviour and its own answer to
--   "which one does the export read", and it would put the two bodies of one page in two places
--   that can disagree about the path.
--
-- HAZARDS, STATED NOT HIDDEN
--
--   * Every existing row gets `draft_* = ''` — the honest seed: no work in progress. A page
--     that was mid-edit under the old model is `status = 'draft'` with its content in
--     `body_html`, which is exactly the state the new model calls "never published". Nothing is
--     lost and nothing is silently promoted: `draft_sha = ''` means "nothing to publish", and
--     publishing such a page is the same operation it always was.
--   * `draft_html` carries the same five bans as `body_html` (no <script>, no <style>, no HTML
--     comment, no javascript:, no srcdoc). The draft is what the editor writes, and the editor
--     is the surface with the least trust in its input.
--   * `PRAGMA foreign_keys` is set OUTSIDE the transaction (inside one it is a silent no-op),
--     the same discipline r2, r3 and r4 document. This delta adds no parent/child rebuild, so
--     the pragma matters for the discipline, not for the outcome.
--   * ADD COLUMN with a constant default is O(1) in SQLite and cannot fail on existing data:
--     the default satisfies every CHECK for every row already present.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

ALTER TABLE cms_page
  ADD COLUMN draft_html TEXT NOT NULL DEFAULT '' CHECK(draft_html NOT LIKE '%<script%' AND draft_html NOT LIKE '%<style%' AND draft_html NOT LIKE '%<!--%' AND draft_html NOT LIKE '%javascript:%' AND draft_html NOT LIKE '%srcdoc%');

ALTER TABLE cms_page
  ADD COLUMN draft_css TEXT NOT NULL DEFAULT '';

ALTER TABLE cms_page
  ADD COLUMN draft_sha TEXT NOT NULL DEFAULT '' CHECK(length(draft_sha) IN (0,64));

ALTER TABLE cms_page
  ADD COLUMN draft_updated_at TEXT;

PRAGMA user_version = 5;

COMMIT;

PRAGMA foreign_keys = ON;
