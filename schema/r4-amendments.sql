-- r4-amendments.sql — the v3 -> v4 delta for a tenant site.db.
--
-- Applies to a site.db at PRAGMA user_version = 3 (schema/site.sql v3, or v1 + r2 + r3) and
-- yields user_version = 4, which is the shape schema/site.sql now generates. The convergence
-- of this chain on schema/site.sql is asserted by scripts/model/verify_claims.py check 20:
-- table set, column set per table, trigger set and registry rows are compared, so the two
-- artefacts cannot drift without `make test` failing.
--
-- WHAT THIS ADDS AND WHY (02-errata E-31 item 5)
--
--   `cms_plugin_installed.activation_seq` — the durable half of §13.3.2's cache-buster.
--
--   The counter was process-wide in the registry, which is enough for Node's ESM cache
--   *inside one process* and is the exclusive witness of L9 (disable→enable must produce a
--   new module instance). It is not enough across a restart: a new process starts at zero,
--   hands `import()` the same `?tenant=…&act=1` URL it used before, and receives the module
--   namespace the previous process had already evaluated — with its module-level state and
--   its timers. Durable state is the only thing that makes "a restart loaded the package
--   again" true rather than lucky.
--
--   `DEFAULT 0` is the honest seed, not a guess: 0 means "this row has never been activated
--   on this database". The next enable reads the row, adds one, writes it back in the same
--   transaction that sets `enabled = 1`, and the number it wrote is the number the module's
--   URL carries — so the row and the URL cannot disagree (§13.3.2 step 6 vs step 10).
--
--   No table rebuild: ADD COLUMN with a constant default is O(1) in SQLite and cannot fail on
--   existing data, because the default satisfies the CHECK for every row already present.
--
-- HAZARDS, STATED NOT HIDDEN
--
--   * A v3 database that has plugins installed keeps them; nothing is re-imported by this
--     migration and no `enabled` flag is touched. Each package's next activation starts at 1.
--   * `PRAGMA foreign_keys` is set OUTSIDE the transaction (inside one it is a silent no-op),
--     the same discipline r2 and r3 document. This delta has no parent/child rebuild, so the
--     pragma matters only for the discipline, not for the outcome.

PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

ALTER TABLE cms_plugin_installed
  ADD COLUMN activation_seq INTEGER NOT NULL DEFAULT 0 CHECK(activation_seq >= 0);

PRAGMA user_version = 4;

COMMIT;

PRAGMA foreign_keys = ON;
