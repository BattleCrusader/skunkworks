# R1 — Data Model

**Author:** Data Model Specialist · **Round 1 of 3** · 2026-10-20
**Builds on:** `IDEA.md` D1–D24. This paper does not restate them; it specifies what they imply and
where they break.

**Artefacts shipped with this paper** (all generated from one spec, so ER↔DDL parity is mechanical):

| Path | Contents |
|---|---|
| `schema/control.sql` | 7 tables, 63 columns, 5 FK clauses |
| `schema/site.sql` | 20 tables, 155 columns, 14 FK clauses |
| `docs/debate/diagrams/r1-data-model.puml` | 27 entities, 19 relationships |
| `docs/debate/diagrams/r1-data-model.png` | 129,230 B, 3341×1419 |
| `scripts/model/gen_schema.py` | the spec; emits all four above |
| `scripts/model/validate_schema.py` | applies the DDL to real files and runs 12 negative tests |

Verified on SQLite 3.53.2 (better-sqlite3 12.11.1, Node 22.23.1) and CLI 3.43.2:
`control.db: 7 tables, 7 explicit indexes, 5 FK clauses, integrity=ok, fk_check=0 violations`;
`site.db: 20 tables, 13 explicit indexes, 14 FK clauses, integrity=ok, fk_check=0 violations`,
plus 12/12 negative tests rejecting what must be rejected. Empty `site.db` = 225,280 B.

---

## 1. Invariants I will defend (numbered, falsifiable)

Each one names the command or test that fails if it is false.

**I1 — A connection belongs to exactly one tenant for its entire life, and `control.db` and a
`site.db` are never open on the same connection.**
There is exactly one connection factory, `getTenantDb(tenantId, {mode})`, and it takes a tenant id
by signature. *Falsifier:* `SELECT name FROM pragma_database_list` on any handle returned by the
pool must yield exactly `['main']`; a second row is a breach. Additionally, `ATTACH` must never be
reachable (I2), because a readonly handle is not a tenancy control (I5).

**I2 — No SQL text authored by anyone outside `src/db/` reaches the engine.**
The DDL runner accepts a JSON AST — table, columns, types, FK targets — and emits SQL itself.
There is no `exec(userText)` entry point, not even behind an admin flag. *Falsifier:* submit
`{name: "u_x", columns: [{name: "c", type: "TEXT", default: "ATTACH DATABASE '/srv/skw/tenants/beta/site.db' AS v"}]}`
and get `422 DM_E_DDL_REJECTED`. If text does reach the engine, I measured what happens next — see
§6, M9: two statements copy another tenant's `cms_download_code` rows into the attacker's file and
the copy survives a reopen, i.e. it ships in the export bundle.

**I3 — Every `u_*` table's FK targets are drawn from a closed set: `cms_asset(key)`,
`cms_asset_bundle(key)`, `cms_page(path)`, or `u_<name>(id)`.** Nothing else.
*Falsifier:* parse `sqlite_master.sql` for every `u_*` table and assert every `REFERENCES` target is
in that set. This is the invariant that makes `u_*` exportable: a user table can only point at
things that travel in the same file.

**I4 — An export, opened alone on a fresh connection, returns the same row counts, the same
`sqlite_sequence` values, and zero `foreign_key_check` violations as the source.**
*Falsifier:* `cp site.db` fails this (measured: `no such table: u_post`); `VACUUM INTO` passes
(measured). I4 is what makes the 5-minute install a real claim rather than a file that happens to
untar.

**I5 — `readonly` is a write boundary, not a tenancy boundary.**
*Falsifier:* open a readonly handle on tenant A's file, `ATTACH` tenant B's file, `SELECT` — I got
**50 rows** back. Any design that says "the render path uses a readonly connection, therefore it
cannot reach another tenant" is false, and I have the output.

**I6 — A reference key is canonical, lowercase, constrained by CHECK, and immutable while
referenced — enforced by the database, not by application code.**
*Falsifier:* `UPDATE cms_asset SET key='banner-home-2'` while a `u_*` or `cms_asset_link` row
references it must raise `FOREIGN KEY constraint failed`. Measured: it does, provided the FK is
declared `NO ACTION`/`RESTRICT` on update rather than `ON UPDATE CASCADE`. The rename of an
unreferenced key succeeds (also measured) — which is the correct behaviour: before it is used, a
key is just a name.

**I7 — No table in `site.db` stores a filesystem path, a URL, or a checksum as content.**
`cms_asset.storage_path` and `cms_asset_variant.storage_path` are the only path columns, they are
derived, and no `u_*` or `cms_*` content column may hold one. *Falsifier:* a query that finds a
`/` or a 64-hex string in a content column of `u_*`; plus a CI grep for `storage_path` outside
`src/media/`.

**I8 — Every `cms_*` table is in 3NF, with exactly four named exceptions, each carrying a measured
reason (§2, DM6).** *Falsifier:* a `cms_*` column functionally determined by a non-key, non-listed
column. The audit is to be a view (`schema/3nf-audit.sql`, which must ship with the SDS — it does not
exist yet) listing every `(table, column, determinant)` triple; any row not matching the DM6 list
fails review.

---

## 2. Decisions — each: Decision / Alternatives rejected / Why they lost / Failure mode if wrong

Format: **Decision / Alternatives rejected / Why they lost / Failure mode if wrong.**

### DM1 — Two files, and tenancy is a *topology* property with three independent mechanisms

**Decision.** `control.db` holds the fleet (7 tables). Each tenant gets `tenants/<key>/site.db`
(20 tables + `u_*`). Three mechanisms, each sufficient alone:
(a) one file per tenant, and the only path-construction site is `tenantDbPath(tenant)` reading
`tenant.key` from `control.db` — no request value ever becomes a path segment;
(b) `ATTACH` is unreachable because no SQL text is accepted (I2), and the DDL runner asserts
`pragma_database_list` has one row inside the transaction;
(c) the pool hands out `{conn, tenantId}` tuples; there is no `getDb()`.

**Alternatives rejected.**
1. *One `site.db` with a `tenant_id` column on every table and a mandatory WHERE clause.* Lost
   because SQLite has no row-level security: enforcement would be a lint rule and a code review,
   which is precisely the "discipline, not topology" my mandate forbids. One missed predicate in a
   data source is a fleet-wide leak, and the export becomes the "filtered-schema nightmare" D2 was
   written to avoid.
2. *One file, one SQLite schema per tenant (`tenant_abc.cms_page`).* Lost because SQLite schema
   names are identifiers with no namespace isolation — a `SELECT` can name any schema — and export
   becomes a per-schema dump rather than a byte copy.
3. *One file per tenant but a shared connection pool keyed by path string.* Lost on I1 and on
   measurement M9b: `ROLLBACK` does not undo `ATTACH`, so a single failed DDL transaction leaves a
   pooled connection attached to a foreign tenant, and the *next* request on that slot can read it.
   I reproduced exactly that: same handle, victim rows, after rollback.

**Failure mode if wrong.** If (a) is violated anywhere — a route that concatenates a request value
into `tenants/<x>/site.db` — then `..%2f` in a path parameter reads any file on the box, and no
other mechanism catches it because the connection legitimately has one `main`. The mitigation is
mechanical: `tenantDbPath` is the only function that touches `SKW_DATA_DIR`, and a test asserts
no other module imports `node:path` for a DB path.

### DM2 — The DDL runner compiles a JSON AST and asserts postconditions inside the transaction

**Decision.** Input is a structure, never a string:

```ts
type DdlOp =
  | {op:'create_table', name:`u_${string}`, columns: ColumnSpec[], indexes: IndexSpec[]}
  | {op:'add_column',    table:`u_${string}`, column: ColumnSpec}
  | {op:'drop_column',   table:`u_${string}`, column:string}
  | {op:'rename_table',  from:`u_${string}`, to:`u_${string}`}
  | {op:'create_index',  table:`u_${string}`, columns:string[], unique:boolean}
  | {op:'drop_index',    name:`ix_u_${string}`}
  | {op:'drop_table',    name:`u_${string}`}
```
`ColumnSpec.type ∈ {TEXT, INTEGER, REAL, BLOB, NUMERIC, BOOLEAN, DATE, ASSET, PAGE, RELATION}`.
`ASSET` becomes `TEXT REFERENCES cms_asset(key) ON UPDATE RESTRICT ON DELETE RESTRICT`;
`PAGE` becomes `TEXT REFERENCES cms_page(path) …`; `RELATION` becomes `INTEGER REFERENCES u_x(id) …`.
There is no `default` that is interpolated — defaults are literals from a typed union.

The runner then executes, in one `BEGIN IMMEDIATE`, and checks five postconditions **before**
`COMMIT`:

```sql
SELECT count(*) FROM pragma_database_list;                       -- must be 1
SELECT count(*) FROM sqlite_master WHERE type='trigger';          -- must be 0
SELECT count(*) FROM sqlite_master WHERE type='view'
  AND name NOT IN (SELECT name FROM cms_view_registry);           -- must be 0
SELECT count(*) FROM sqlite_master WHERE type='table'
  AND name NOT LIKE 'u\_%' ESCAPE '\' AND name NOT LIKE 'cms\_%' ESCAPE '\'
  AND name NOT LIKE 'sqlite\_%' ESCAPE '\';                       -- must be 0
PRAGMA foreign_key_check;                                         -- must be empty
```
Any non-zero result → `ROLLBACK`, then `DETACH` every non-`main` database, then **discard the
connection** (`DM_E_DDL_POSTCONDITION`).

**Alternatives rejected.**
1. *Regex/keyword allowlist over submitted SQL text.* Lost because the attack does not live in the
   identifier — it lives in the statement kind. Measured (M9): `ATTACH` + `CREATE TABLE … AS SELECT`
   is two ordinary statements; the identifier regex `^u_[a-z0-9_]+$` passes both. A text filter
   must also survive `VACUUM INTO '/any/writable/path'`, which is a single statement that writes a
   file anywhere the process can write.
2. *Block ATTACH via the C API (`SQLITE_LIMIT_ATTACHED = 0`).* Lost because it is not reachable
   from the driver: `db.setLimit` and `db.db_config` are both `undefined` in better-sqlite3 12.11.1
   (M10). The defence cannot be bought; it has to be designed.
3. *Rely on `PRAGMA writable_schema` being blocked.* It already is — better-sqlite3 opens with
   `SQLITE_DBCONFIG_DEFENSIVE`, so `PRAGMA writable_schema=ON` is a no-op and `UPDATE sqlite_master`
   fails with "table sqlite_master may not be modified" (M10). Good, but it is a property of the
   driver, not of my design, so it is a bonus, not a load-bearing wall.

**Failure mode if wrong.** If the AST compiler has a hole (e.g. a `RELATION` target that is
interpolated rather than validated against `cms_table_registry`), the blast radius is arbitrary DDL
on that tenant's file — dropping `cms_asset` loses its rows but the schema can be recreated from
migrations; the data cannot. The containment is the pre-migration `VACUUM INTO` backup (DM8), which
is why that is not optional.

### DM3 — Asset identity is a canonical text key, it is the FK target, and it freezes on first reference

**Decision.** `cms_asset.key TEXT NOT NULL UNIQUE COLLATE NOCASE` with CHECKs that force canonical
form:

```sql
CHECK(key = lower(key))
CHECK(length(key) BETWEEN 1 AND 96)
CHECK(key NOT GLOB '*[^a-z0-9/_.-]*')
CHECK(key NOT GLOB '/?*')      -- no leading slash
CHECK(key NOT GLOB '*/')       -- no trailing slash
CHECK(key NOT GLOB '*..*')     -- no traversal segment
CHECK(key NOT GLOB '.?*')      -- no dotfile
```
`u_*.asset` columns are `TEXT REFERENCES cms_asset(key) ON UPDATE RESTRICT ON DELETE RESTRICT`.
`ON UPDATE RESTRICT` (not CASCADE) is the whole trick: renaming a referenced key becomes a
*foreign-key violation*, so "you cannot rename an asset that is in use" is enforced by SQLite.
Old keys land in `cms_asset_alias` and 301 at `/media/<old-key>`.

**Alternatives rejected.**
1. *`u_*.cover INTEGER REFERENCES cms_asset(id)`.* Lost on the brief itself: §7.3 asks for a row
   that reads `banner-home` when you open it, not `1`. It also loses the export story — an integer
   id is only meaningful relative to the sequence of the file that produced it, and M4 shows that
   sequence is not stable across a table rebuild.
2. *Free renames with `ON UPDATE CASCADE`.* Lost on measurement M8: renaming one key referenced by
   200,000 rows took **439 ms** of write-lock time on a settled database — and **2,412 ms** when the
   same UPDATE ran inside the transaction that had just inserted the 200,000 rows. Either way every
   writer on that tenant gets `SQLITE_BUSY` for the duration, and the operation rewrites 200,000 rows
   of user data plus the WAL that carries them. A rename button that stalls the site is a bug with a
   nice UI.
3. *Soft delete with a partial unique index — `CREATE UNIQUE INDEX … ON cms_asset(key) WHERE deleted_at IS NULL`.*
   Lost on measurement M2: **a partial unique index cannot be an FK parent.** `foreign key mismatch -
   "u_product" referencing "cms_asset"`. Every `u_*` table with an asset column would be broken, at
   create time, with an error that names the wrong table.
4. *Case-insensitive keys without a CHECK (`COLLATE NOCASE` alone).* Lost on M3: FK matching uses
   the *parent index* collation, so a BINARY child column happily matches `'Banner-Home'` against
   `'banner-home'`, while a BINARY index scan on the child does not. The same logical key would match
   on join and miss on lookup. Canonical lowercase means the two collations agree by construction.

**Failure mode if wrong.** If a key can drift in case or contain `..`, the asset pipeline's
filename-based symlink farm writes outside its directory (measured, §4 A4), and `/media/` becomes a
file-disclosure surface. If the freeze is bypassed, references silently break on rename and the
export's FK check fails at install time on the client's box.

### DM4 — `AUTOINCREMENT` only where an id is externally visible, and the sequence is restored after every rebuild

**Decision.** `AUTOINCREMENT` on `cms_page`, `cms_asset`, `cms_download_code`, `cms_asset_link`,
`cms_audit`, `cms_redirect`, `cms_form`, `cms_form_submission`, `cms_asset_bundle`, `cms_nav`,
`cms_table_registry`, `cms_page_revision`, and on every runner-created `u_*` table. Plain
`INTEGER PRIMARY KEY` on pure child tables whose ids are never referenced:
`cms_asset_variant`, `cms_download_event`, `cms_watermark_render`, `cms_asset_bundle_item`.

Every rebuild (the 12-step procedure, needed for any constraint change `ALTER TABLE` can't do)
must carry the counter forward. Measured (M5): the sequence for `u_post` went **5 → 3** across a
correct, documented rebuild, because the rebuilt table's `sqlite_sequence` row is recomputed from
`max(id)`; ids 4 and 5 were then reissued. The fix is a plain `UPDATE`, no `writable_schema`:

```sql
UPDATE sqlite_sequence SET seq = :old_seq WHERE name = 'u_post';
```

**Alternatives rejected.**
1. *Never use `AUTOINCREMENT`.* Lost on measurement M6: without it, deleting the highest row and
   inserting reuses that id (`max(id)` came back as 3 after deleting 3 and inserting). A reused id
   silently repoints an audit `target_id`, a bookmarked admin URL, and an exported snapshot.
2. *Use `AUTOINCREMENT` everywhere.* Lost because it costs a `sqlite_sequence` row and a table lock
   per insert for tables whose ids are never read — and it does not protect against the rebuild bug
   anyway (M5 happened *with* `AUTOINCREMENT`).
3. *Make ids UUIDs.* Lost on size and index locality: 36-byte random keys in the primary index, and
   every `u_*` relation column grows by 28 bytes per row. Not worth it for a single-writer file.

**Failure mode if wrong.** A reissued id means an exported snapshot's `cms_asset_link.owner_id`
points at the wrong page after a schema change — a data-corruption bug that looks like a rendering
bug and will be debugged for days.

### DM5 — A page is one document, not a block tree; `cms_page_blocks` is removed from §6

**Decision.** `cms_page(id, path, slug, title, status, template, body_html, css, seo_json, etag,
published_at, …)`. `path` is the identity: `TEXT NOT NULL UNIQUE COLLATE NOCASE` with
`CHECK(path GLOB '/*' AND path NOT GLOB '*..*' AND path NOT GLOB '*/')`. Revisions are append-only
rows in `cms_page_revision` so a hand edit is undoable.

**Alternatives rejected.**
1. *`cms_page_blocks(id, page_id, position, block_type, props_json)` as §6 lists.* Lost on D21's own
   acceptance test. GrapesJS's model is a *nested component tree*; a flat ordered table cannot hold
   the nesting, so the load-parse-save cycle has to invent a tree, and inventing it changes the
   markup. The gate is an **empty diff**. A block table makes that gate unachievable by
   construction — you would be normalising and de-normalising the document on every save.
2. *Adjacency list with `parent_id` (a real tree table).* Lost because every re-serialisation is a
   recursive walk whose ORDER BY, whitespace and attribute order are decisions I would have to
   re-derive to bit-match GrapesJS. Storing the document verbatim is the only way to guarantee
   `load → save → diff == 0`.
3. *Both: store HTML and a denormalised block index for querying.* Lost as unnecessary: nothing in
   v1 needs to query inside a page body. `cms_asset_link` already gives me "what uses this asset"
   because the editor writes the link rows.

**Failure mode if wrong.** If GrapesJS is later replaced by an editor whose document format is not
HTML+CSS, `body_html` becomes a foreign blob and the migration is a re-parse of every page. That
risk is accepted: D21 pins the component vocabulary to GrapesJS's own output.

### DM6 — 3NF/BCNF with four named exceptions, each with a measured or structural reason

**Decision.** Every `cms_*` table is 3NF; `cms_asset_variant`, `cms_asset_bundle_item`,
`cms_nav`, and `cms_asset_link` have composite candidate keys and are BCNF. Four exceptions:

| # | Exception | Reason | Consequence if removed |
|---|---|---|---|
| E1 | `cms_download_code.uses` is a counter derived from `count(cms_download_event)` | D19 requires a single atomic `UPDATE … WHERE uses < max_uses`; deriving it needs a subquery plus a read-modify-write, which is exactly the race D19 exists to prevent | Redemption becomes racy under concurrency; a code can exceed `max_uses` |
| E2 | `cms_asset.bytes` and `cms_asset.sha256` are also derivable from the file on disk | SQL cannot read the filesystem; the row must be queryable without I/O | Media library listing becomes an `fs.stat` per row |
| E3 | `cms_page.etag` is derived from `body_html + css + updated_at` | It is the cache key; computing it per request rehashes the body | Cache validation cost moves into the render path |
| E4 | `cms_settings` is key-value (EAV-shaped) | It holds *configuration*, not content; the alternative is 40 columns of which 38 are NULL per tenant | A settings table that changes shape with every feature |

E1 gets a reconciliation query that runs on demand and in CI, not on a schedule:

```sql
SELECT c.id, c.uses, count(e.id) AS events
  FROM cms_download_code c LEFT JOIN cms_download_event e
    ON e.code_id = c.id AND e.outcome = 'ok'
 GROUP BY c.id HAVING c.uses <> events;
```

**Alternatives rejected.**
1. *Perfect 3NF everywhere, derive `uses` from events.* Lost on E1's race.
2. *A full EAV content model (`cms_entity`, `cms_attribute`, `cms_value`).* Lost because it makes
   every read a pivot, destroys `CHECK` constraints (you cannot CHECK a value whose type lives in
   another row), and pushes type integrity into application code — violating non-negotiable #2.

**Failure mode if wrong.** If E1 drifts, `max_uses` is decorative and a paid asset circulates. The
reconciliation query is the detector; the alert threshold is "any row" — not a percentage.

### DM7 — Audit is split: `control.db.audit_log` for the fleet, `site.db.cms_audit` for the tenant

**Decision.** A control-plane action (tenant create, domain add, deploy token issue, user create)
writes one `audit_log` row. A tenant-plane action (page edit, DDL, code issue, cap change, asset
delete) writes one `cms_audit` row. **No action writes to both.** `actor_label` is denormalised
into both so that deleting a user does not erase attribution — and there is deliberately **no FK**
from either table to `user_account`.

**Alternatives rejected.**
1. *One global `audit_log`, as §6 lists.* Lost three ways: (a) every tenant write becomes a write to
   the global file, so a fleet-wide single-writer bottleneck appears on the DB that must stay
   available to route requests; (b) an exported CMS ships with **no audit history of its own
   content**, so the client's instance starts blind and the "who deleted my page" question has no
   answer on their box; (c) the tenant's audit rows would be in a file the client cannot see, which
   makes the export claim ("only that website's data") false in the other direction — it exports
   nothing of the history.
2. *Audit into both, for belt and braces.* Lost because a partial failure between the two writes
   gives two sources of truth that disagree, and the reconciliation is a distributed transaction in
   a product whose selling point is a single file.

**Failure mode if wrong.** If tenant-plane writes leak into `audit_log`, the global DB grows
proportional to *content* edits across the fleet, and every content save contends with tenant
lookup on the file that must answer every request. Measured cost of a write: `busy_timeout=0` lost
150 of 200 writes under four writers (M7) — that is the queue you would be joining.

### DM8 — Export is `VACUUM INTO`, never a copy; the file says what it is

**Decision.**
```sql
PRAGMA wal_checkpoint(TRUNCATE);           -- 104 ms on a 398 MB file (M12)
VACUUM INTO '/staging/<tenant>/data/site.db';
```
Then, on a **fresh connection** to the output: `PRAGMA application_id` must be `0x534B5701`;
`PRAGMA user_version` must equal `tenant.db_version`; `PRAGMA integrity_check` must be `ok`
(276 ms at 398 MB); `PRAGMA foreign_key_check` must be empty; `PRAGMA journal_mode` must be set to
`wal` (the copy comes out in `delete` mode — measured).

The `VACUUM INTO` must run on a **dedicated short-lived connection that is not in a transaction**:
on a connection holding one it fails outright with `cannot VACUUM from within a transaction` (M21),
and from a separate connection it is a consistent snapshot that excludes uncommitted rows (M21).

**Alternatives rejected.**
1. *`cp tenants/<key>/site.db bundle/data/site.db` — "one file per tenant means a copy" (IDEA §5).*
   Lost on measurement M1: the main file was **4,096 bytes** and held nothing; 1,000 rows lived in a
   32,992-byte `-wal`. The copy answered `no such table: u_post`. A bundle built this way installs
   cleanly and shows an empty site. This is the single most dangerous sentence in `IDEA.md`.
2. *`cp` the `-wal` alongside.* Works in the test (1,000 rows) but is not atomic: a checkpoint can
   truncate the WAL between the two copies, and the bundle then carries a stale WAL that SQLite will
   replay over a newer main file. Also the client's `install.sh` has to remember to keep them
   together forever.
3. *`VACUUM INTO` without the post-checks.* Lost because `VACUUM INTO` silently changes
   `journal_mode` to `delete`, and the output can carry `auto_vacuum=2` while the *live* connection
   still reports `0` (M13) — the connection's copy of that pragma is stale relative to what the
   export wrote. Verifying against the live connection is checking the wrong file.

**Failure mode if wrong.** A bundle that installs and serves a blank site, discovered by the client.
Severity: fatal to the commercial intent in §1.1.

### DM9 — Connection pragmas: WAL once at bootstrap, everything else per connection

**Decision.** Exactly two preambles exist in code:

```ts
// bootstrap, once per file, on the migration connection
PRAGMA journal_mode = WAL;      // persistent in the file header — do not repeat per connection
PRAGMA auto_vacuum = NONE;      // must be set before the header exists, or VACUUM silently defers it

// every pooled connection, in this order, before the handle is released to callers
PRAGMA busy_timeout = 5000;     // default is 0
PRAGMA foreign_keys = ON;       // default is OFF, and per-connection
PRAGMA synchronous = NORMAL;    // WAL-safe: one fsync per checkpoint, not per commit
PRAGMA trusted_schema = OFF;
PRAGMA recursive_triggers = OFF;
PRAGMA temp_store = MEMORY;
```
`foreign_keys` is toggled **only outside a transaction** — inside one it is a silent no-op (M3b:
`1 → 1 → 1` across `BEGIN; PRAGMA foreign_keys=OFF; COMMIT`). Nothing anywhere sets
`wal_autocheckpoint = 0`.

**Alternatives rejected.**
1. *Set `journal_mode=WAL` on every connection* (the common copy-paste). Lost because it is a write
   operation with a lock: in the four-writer run one process died at
   `c.execute("PRAGMA journal_mode=WAL")` with `database is locked`. It also returns the existing
   mode, so the only thing re-setting it buys is a lock hazard.
2. *`busy_timeout = 0` (the SQLite default).* Lost on M7: four writers, 200 transactions —
   **50 succeeded, 150 failed with SQLITE_BUSY** (0 ms tolerance). At 5,000 ms: 200/200 in 71 ms.
3. *`synchronous = FULL`.* Lost because in WAL mode it costs an fsync per commit for a durability
   guarantee the export path already provides via `VACUUM INTO`; `NORMAL` can lose the last
   transaction on an OS crash, and a CMS that loses the last edit is acceptable where one that
   takes 4 ms per save is not.

**Failure mode if wrong.** `foreign_keys` off on one pooled connection means one admin session can
delete an in-use asset and leave every page referencing it pointing at nothing — and the failure is
invisible until render. The preamble is therefore in the factory, not in callers, and a test asserts
`PRAGMA foreign_keys` is 1 on every handle the pool ever hands out.

### DM10 — A bounded LRU of open handles, and DDL connections are never pooled

**Decision.** `SKW_DB_POOL_MAX` (default 64) handles, LRU-evicted and closed. Measurement M11:
200 open readonly handles cost **36.1 MB RSS (185 KB each)**, 3 file descriptors each, and 0.69 ms
to open + run one query cold; a warm query is 0.024 ms. So an unbounded map is 185 KB × tenants —
36 MB at 200 tenants, 370 MB at 2,000 — and per-request opening costs 0.69 ms, which is 10% of a
7 ms page render.

A connection that has executed DDL is closed, never returned to the pool, because `ATTACH` survives
`ROLLBACK` (I1, M9b).

**Alternatives rejected.**
1. *One handle per tenant, held forever.* Lost at 2,000 tenants; also every tenant migration then
   needs every handle closed and reopened.
2. *Open per request.* Lost on 0.69 ms × sources × pages, plus `-shm` creation each time.

**Failure mode if wrong.** Pool thrash: with more than `SKW_DB_POOL_MAX` active tenants, every
request pays the cold 0.69 ms. Degradation, not failure — and the metric to watch is
`skw_db_open_total` rate, not latency.

### DM11 — `user_version` is authoritative; migrations fan out eagerly but are resumable

**Decision.** `site.db` `PRAGMA user_version` is the schema version. `control.db.tenant.db_version`
is the version that tenant *should* be at. On deploy, a fan-out applies missing migrations, per
tenant, each in `BEGIN IMMEDIATE` after a `VACUUM INTO` backup. Measured (M14): one migration plus a
backup across 200 tenants = **811 ms total, 4.05 ms/tenant**, 200/200 succeeded. A `site.db` whose
`user_version` is below required serves `503 DM_E_SCHEMA_STALE` and triggers a lazy repair of that
one tenant.

**Alternatives rejected.**
1. *Drizzle's `__drizzle_migrations` per tenant as the source of truth.* Lost because the table
   lives *inside* the file the client owns and can edit; `user_version` is in the header, survives
   `VACUUM INTO` (measured), and cannot be dropped by an accidental `DROP TABLE`. Drizzle's journal
   is kept in `control.db` as advisory.
2. *Lazy-only migration.* Lost because the first request after a deploy pays the migration on a
   render path, and one broken tenant then breaks a live page view instead of a deploy.
3. *Eager without per-tenant versioning.* Lost because a fan-out that dies at tenant 137 has no way
   to resume, and re-running it re-applies migrations to the first 136.

**Failure mode if wrong.** A migration applied twice is the classic corruption: `ADD COLUMN` fails
loudly, but a `CREATE TABLE … AS SELECT` or a data backfill duplicates rows silently. The
`user_version` check inside the same transaction as the DDL is the guard.

### DM12 — `cms_download_code` needs an HMAC lookup column; argon2id alone cannot be queried

**Decision.**
```sql
code_lookup TEXT NOT NULL UNIQUE CHECK(length(code_lookup) = 64),  -- HMAC-SHA256(pepper, normalised code)
code_hash   TEXT NOT NULL,                                          -- argon2id(m=64MiB,t=3,p=1)
```
Redemption: `SELECT … WHERE code_lookup = ?` (0.56 ms, unique index seek), then `verify(code_hash)`
(70 ms idle → 1.13 s loaded; eight runs, load-dependent — re-run `scripts/model/verify_claims.py` for this box's number), then the atomic `UPDATE … WHERE uses < max_uses` from D19.

**Alternatives rejected.**
1. *`code_hash` only, as §7.4/§9 describe.* Lost on measurement M15: argon2id is salted, so **two
   hashes of the same code are different strings** — `WHERE code_hash = ?` can never find the row.
   Verification therefore means scanning: at 5,000 codes, finding one takes **≈358 s to 1.6 h per
   attempt** (fastest to slowest observed), against a 600 s token TTL — 0.6× to 9.4× its life. The
   endpoint cannot complete one request, and it worsens exactly when redemption traffic arrives,
   because argon2id at 64 MiB is memory-bandwidth bound. The blocker is the zero-row lookup, not the
   constant: any argon2id setting strong enough to be worth using makes the scan hopeless.
2. *Store the code in plaintext to make lookup possible.* Lost on D15 and Security's non-negotiable
   #2, and it is unnecessary — the HMAC is one indexed column.
3. *Give the code a visible prefix (first 4 chars = selector).* Lost because it shrinks the search
   space by 20 bits *and* leaks structure; the HMAC costs 0.56 ms and leaks nothing.
4. *No pepper — plain SHA-256 of the code as the lookup.* Lost because a DB leak then allows an
   offline dictionary over the 60-bit space at GPU speed with no server secret involved. The pepper
   is a secret in `.env` (`SKW_CODE_PEPPER`, 32 bytes base64), so a stolen file alone is not enough.

**Failure mode if wrong.** If the pepper is rotated without reissuing codes, every outstanding code
stops working — a support incident, not a data loss. Document it in `install.sh` output.

---

## 3. Interface contracts I require from other domains (signatures, routes, env vars, paths, error codes)

### 3.1 From Runtime

```ts
// The only way to obtain a database handle. src/db/tenant.ts
type TenantId = number & {readonly __tenant: unique symbol};
type DbMode = 'read' | 'write';

interface TenantDb {
  readonly tenantId: TenantId;
  readonly mode: DbMode;
  /** Autocommit only. Must not be called when db.inTransaction is true. */
  source<T>(key: string, params?: Record<string, unknown>): Promise<T[]>;
}
declare function getTenantDb(tenantId: TenantId, opts: {mode: DbMode}): TenantDb;
// No overload without tenantId. No default parameter. No `getDb()` anywhere.
```

1. **`getTenantDb` is the only export of `src/db/tenant.ts`,** and `src/db/**` is the only place
   `better-sqlite3` may be imported (ESLint `no-restricted-imports`, CI-enforced).
2. **No request-scoped `BEGIN`.** `db.inTransaction` must be `false` when `source()` is entered and
   must remain so between sources. Rationale, measured: a held read snapshot prevents WAL truncation
   (M7b), and any code that also sets `wal_autocheckpoint=0` turns that into unbounded growth
   (12.4 MB of WAL for 3,000 tiny rows against an 8 KB main file).
3. **`source()` issues one statement per call** against a prepared statement cache keyed by
   `(tenantId, kind, specHash)`; a cache entry is invalidated when `cms_datasource.published_at`
   changes.
4. **Route → source mapping must be explicit**; `Astro.locals.site.source` resolves through
   `cms_datasource.key`, and `is_public = 0` throws `DM_E_DATASOURCE_PRIVATE` (404, not 403 — do not
   confirm existence).
5. **Path resolution:** `GET <any>` → exact `cms_page.path` match (NOCASE) → else exact
   `cms_redirect.from_path` match → 301/302/308 → else 404. The app must not normalise the path
   beyond what nginx already did; `cms_page.path` stores the canonical form
   (`/`, no trailing slash, no `..`), enforced by CHECK.
6. **Island props are serialised at SSR and contain no `TenantDb`,** no asset paths, no checksums —
   only `{url, width, height, alt}` shapes.

### 3.2 From Security

1. **`hashCode`** returns both columns, in one call, so they cannot drift:
   ```ts
   function hashCode(code: string): Promise<{lookup: string; hash: string}>;
   // lookup = hex(HMAC-SHA256(base64decode(SKW_CODE_PEPPER), crockfordNormalise(code)))
   // hash   = argon2id(m=65536, t=3, p=1, outputLen=32)  → 70 ms idle, 1.13 s loaded, measured
   ```
   Normalisation: uppercase, strip `-` and whitespace, map `I→1 L→1 O→0 U→V` per Crockford.
   **The same normalisation must be applied on both issue and redeem**, or the HMAC will not match.
2. **argon2id parameters are frozen** at `m=65536, t=3, p=1`. Changing them is a schema event: the
   hash string embeds the parameters, so old hashes keep verifying, but the verify-cost budget in
   the redemption path must be re-measured.
3. **Exactly one argon2id verification per HTTP request.** Dummy-verify on unknown codes is fine
   (constant time), but it must use a *pre-computed* dummy hash so it does not add a second 121 ms.
4. **`auditWrite(actor, action, target, before, after)`** writes exactly one row and returns its id.
   It must not be called twice for one action, and it must not open a transaction (the caller's
   transaction is the unit).
5. **Pepper handling:** `SKW_CODE_PEPPER` is required, 32 bytes base64, and the app must refuse to
   start without it. Rotating it invalidates outstanding codes — surface that in the admin UI before
   rotation, not after.

### 3.3 From Platform

| Item | Contract |
|---|---|
| Paths | `SKW_DATA_DIR=/srv/skw` → `control.db` at `<dir>/control.db`, tenants at `<dir>/tenants/<tenant.key>/site.db`, media at `<dir>/tenants/<tenant.key>/content/` |
| Mount mode | Tenant volume **must be read-write for the app**, even for the render path. A `:ro` mount fails with `SQLITE_READONLY_DIRECTORY` because WAL needs to create `-shm` (M16) |
| Env | `SKW_DATA_DIR` (`/srv/skw`), `SKW_DB_POOL_MAX` (64), `SKW_DB_BUSY_TIMEOUT_MS` (5000), `SKW_CODE_PEPPER`, `SKW_FLEET_MODE` (1) |
| Backup | `VACUUM INTO`, never `cp`; nothing may set `wal_autocheckpoint=0`; a `-wal` file in a bundle is a build failure |
| `install.sh` | `PRAGMA integrity_check` (276 ms at 398 MB), refuse if `application_id != 0x534B5701`, then `PRAGMA journal_mode=WAL` |
| Health | `/healthz` must report `{db: 'ok', tenants_pending_migration: N}` — N non-zero is degraded, not down |
| Export | Every bundle carries `data/site.db` produced by `VACUUM INTO` + the five post-checks of DM8, and `EXPORT-NOTES.md` must also state `cms_table_registry` row count and `cms_download_code` count (must be 0 in a static/Astro bundle) |

### 3.4 Error codes (stable, documented in the SDS)

| Code | HTTP | Body | Raised when |
|---|---|---|---|
| `DM_E_TENANT_UNKNOWN` | 404 | `{tenant}` | key not in `control.db`, or path would escape `SKW_DATA_DIR` |
| `DM_E_SCHEMA_STALE` | 503 | `{have, want}` + `Retry-After: 5` | `user_version` < `tenant.db_version` |
| `DM_E_DDL_REJECTED` | 422 | `{op, reason: 'ident'\|'keyword'\|'fk_target'\|'type'\|'reserved'}` | AST fails validation before any SQL is emitted |
| `DM_E_DDL_POSTCONDITION` | 422 | `{violation: 'attached_db'\|'trigger'\|'unregistered_view'\|'stray_table'\|'fk_violation'}` | in-transaction postcondition failed; transaction rolled back, connection discarded |
| `DM_E_FK_VIOLATION` | 409 | `{table, column, value, referenced}` | FK rejected a write |
| `DM_E_KEY_IN_USE` | 409 | `{key, references}` | rename of a referenced asset key |
| `DM_E_BUSY` | 503 | `{}` + `Retry-After: 1` | `SQLITE_BUSY` after `busy_timeout` |
| `DM_E_QUOTA` | 507 | `{used, quota}` | per-tenant byte quota exceeded |
| `DM_E_EXPORT_UNSAFE` | 422 | `{gated_assets: [...]}` | static/Astro export with gated assets |
| `DM_E_DATASOURCE_PRIVATE` | 404 | `{}` | `is_public = 0` |

### 3.5 From Architect — §6 amendment request

`IDEA.md` §6 lists `cms_page_blocks`, which DM5 removes, and omits five tables this paper needs.
The amendment I am asking for:

- **Remove:** `cms_page_blocks` (DM5).
- **Add:** `cms_asset_alias` (D17's 301 promise needs a table), `cms_page_revision` (silence: a
  designer hand-edits HTML and breaks the page), `cms_redirect` (silence: every slug rename is a
  404), `cms_view_registry` (makes "no user-created views" an in-transaction postcondition rather
  than a policy), `cms_audit` (DM7).
- **Change:** `cms_download_code` gains `code_lookup` (DM12). `cms_datasource.kind` loses `function`
  (see §4 A2).

---

## 4. Attack points — at least 3 outside my domain (claim / failure / severity / settling evidence)

### A1 — Security: `cms_download_code` as specified cannot serve one redemption request

**Claim attacked.** `IDEA.md` §7.4 step 2–4 and §9 ("Gated downloads | argon2id code hashes") assume
codes are verified by comparing against a stored `code_hash`, i.e. that a row can be found by hash.

**Failure.** Argon2id hashes are salted; `WHERE code_hash = ?` matches nothing, ever. The only
implementation that works is scan-and-verify. Measured eight times on an idle-to-loaded box:
`argon2id verify` = 71.5, 75.2, 79.6, 84.7, 85.0, 91.3, 121.3 ms and **1,126.4 ms**; two hashes of
the same code are always different strings; **5,000 codes → ≈358 s to 1.6 h per attempt**. The HMAC token
lives 600 s, so one attempt consumes 0.6× to 9.4× the token's entire life before the user sees a
result. The blocker is the zero-row lookup; the timing is severity, not the argument. The
spread is the second half of the finding: argon2id at 64 MiB is memory-bandwidth bound, so the cost
of one redemption rises by 13× exactly when traffic arrives. Rate limiting (5/15 min per IP) does
not help, because the cost is incurred *before* the outcome is known.

**Severity: blocker.** The gated-download feature — the commercially interesting slice (S3) — does
not function.

**Settling evidence.** Seed `cms_download_code` with 5,000 rows, `POST /d/<key>` with a valid code,
and time it. Expect < 200 ms with `code_lookup` (DM12) and > 10 min without it. I have run the
primitive (M15); the endpoint test is the confirmation.

### A2 — Security: "read-only connection + no raw SQL" does not contain a hostile Data Source

**Claim attacked.** §4's enforcement list — "Render path uses a `{ readonly: true }` connection — it
physically cannot write" — presented as a tenancy control, combined with `kind: 'function'` (a
trusted JS module "runs in-process against a read-only handle").

**Failure.** Two measured facts. First, a readonly handle can `ATTACH` a foreign file and read it:
`{"c":50}` rows from another tenant's `cms_page`. `readonly` blocks writes, not reads. Second,
`ROLLBACK` does not undo `ATTACH`: after a rolled-back DDL transaction, `pragma_database_list` still
showed `['main','other']`, and the *same handle* returned the victim's
`cms_download_code` row (`buyer@acme.com`). So a `function` source is arbitrary code execution with
a cross-tenant read primitive, one line long:

```js
await db.prepare(`ATTACH DATABASE '/srv/skw/tenants/acme/site.db' AS v`).run();
return db.prepare('SELECT * FROM v.cms_download_code').all();
```
That is one tenant's paid-download table, in another tenant's render output.

**Severity: blocker.**

**Settling evidence.** Two integration tests: (a) `POST /admin/datasources {kind:'function'}`
must be rejected with `422 DM_E_DDL_REJECTED` (`cms_datasource.kind` has no `function` value), and a
pre-existing `function` row must fail resolution with an error rather than return rows; (b) run a
deliberately failing DDL op and assert `pragma_database_list == ['main']` afterwards on the *same*
connection. If the runner discards the connection (DM2, DM10) the second test passes trivially —
which is the point: the fix is connection hygiene plus removing `function` from v1.

### A3 — Platform: "one file per tenant, so export is a copy" is false, and the failure is silent

**Claim attacked.** `IDEA.md` §5: "Because the DB is per-tenant and user tables live in that same
file, export has **nothing to filter** — this is why D2 matters." Platform's non-negotiable #2
("no bundle can carry another tenant's data") builds on the same file.

**Failure.** Measured: after 1,000 inserts with no checkpoint, `site.db` was **4,096 bytes**, `-wal`
was **32,992 bytes**, and `cp` of the main file produced a database with `no such table: u_post`.
The bundle installs, `install.sh` reports success, the cert issues, and the client's site is blank —
or worse, ships with schema and no rows. `install.sh` cannot detect this: `integrity_check` on an
empty-but-valid file returns `ok`.

**Severity: blocker** (commercial intent §1.1; the 5-minute promise becomes a 5-minute blank page).

**Settling evidence.** Build a bundle by `cp`, run `install.sh` in a container, then
`SELECT count(*) FROM cms_page` — expect 0. Then rebuild by `VACUUM INTO` and expect the source
count. I ran the primitive (M1); the container run is Platform's to execute.

### A4 — Platform: the symlink farm turns a data-model key into a filesystem write

**Claim attacked.** D13/D18: "removes user-supplied filenames from every filesystem path" — content
addressing is safe *because* no user string reaches a path. But the symlink farm's *link name* is
`content/public/<key>.<ext>`, and `key` is user-supplied.

**Failure.** Measured: my first, plausible-looking CHECK
(`key NOT GLOB '*[^a-z0-9/_.-]*'`) **accepted `../etc/passwd`**, because `/` and `.` are needed for
`products/book-cover`. With such a key, `fs.symlinkSync(target, 'content/public/../SECRET.txt')`
succeeds — I created it and `realpath` resolved it outside `content/public`. The app then creates or
replaces files anywhere its uid can write. It is not a URL-traversal (nginx normalises `..` before
matching), so it is not remote file disclosure; it is arbitrary file creation with the app's
privileges, driven by an admin form field.

**Severity: major** (privileged-user blast radius, not anonymous).

**Settling evidence.** `POST /admin/assets {key: "../x"}` must return 422. Then
`find content/public -type l -lname '*..*' | wc -l` must be 0 on a fixture site. The CHECK in DM3
rejects `../etc/passwd`, `a/../../b` and `.hidden` — I ran all three (M17).

### A5 — Runtime: a request-scoped read transaction sets the tenant's disk high-water mark

**Claim attacked.** §3's request lifecycle ("resolve page slug → render … with a read-only
connection") does not say whether the request is one transaction. The natural implementation —
`BEGIN` at request start for consistency — is a trap.

**Failure.** Measured: one held read snapshot plus `wal_autocheckpoint = 0` grew the WAL to
**12,421,832 bytes** while the main file stayed at **8,192 bytes** for 3,000 tiny rows — a 1,500×
amplification of live data, and `wal_checkpoint(PASSIVE)` could not truncate it (`(0, 3015, 3015)`,
file size unchanged) until the snapshot ended. With the default autocheckpoint (1,000 pages) the
same run left 201,912 B — bounded, because checkpointing still copies pages back; only truncation is
blocked.

**Severity: minor, escalating to major** if anything in the codebase sets `wal_autocheckpoint = 0`
(e.g. a backup implementation that wants to avoid a mid-export checkpoint).

**Settling evidence.** `rg 'wal_autocheckpoint' src/` must return nothing; plus a load test with
`PRAGMA wal_checkpoint(TRUNCATE)` disabled — if a page render holds a snapshot for the whole request,
the per-tenant WAL never returns to 0 between requests. Measured fact to build the alert on: after
the reader released, `PASSIVE` left the WAL at 201,912 B and only `TRUNCATE` took it to 0.

---

## 5. Open questions I cannot resolve alone

1. **Is `u_*` content in the Astro/static export?** If a client's site renders `u_products` through a
   `query` source, the snapshot must carry rows — but the *shape* of a snapshot (one JSON per source,
   or one per table) is Runtime's, and it constrains whether `u_*` rows are exportable at all. My
   schema makes them exportable (they are in the same file); the snapshot format is undecided.
2. **Does a demo tenant get its own `site.db`, or a shared template file with copy-on-write?**
   Own file: 200 demos = 200 files, 4.05 ms/tenant migration fan-out, 185 KB RSS each. Shared:
   no per-tenant DDL, so the table builder becomes a demo-wide weapon. I need Platform's call on
   which cost they would rather carry.
3. **Is `cms_page.path` case-sensitive at the HTTP layer?** My unique index is `COLLATE NOCASE`, so
   `/Pricing` and `/pricing` cannot coexist — which is right if nginx passes case through and wrong
   if a CDN folds it. Platform must confirm no component in front folds case.
4. **`cms_download_event` retention.** It is append-only and grows with downloads. If events are
   deleted, `uses` can no longer be reconciled (E1) — so retention must be "never delete, or delete
   with `uses` snapshotted into an archive table". That is a policy decision, not a schema one, and
   nobody has made it.
5. **Who owns `SKW_CODE_PEPPER` rotation?** It is a Security secret with a Data Model consequence
   (all outstanding codes die on rotation). Needs one owner and one runbook.
6. **Does the sold bundle include `fleet_admin`?** `user_account` models `tenant_id IS NULL` as a
   fleet operator. In a single-tenant install there is no fleet, so either the role exists in a
   one-tenant world (harmless) or the sold build must forbid it (a `.env` gate, and then the schema
   carries a role that can never be used). I lean: keep the role, gate it by `SKW_FLEET_MODE=0`.

---

## 6. What I measured (command + observed output)

All runs on macOS 15.7.4, Node 22.23.1, better-sqlite3 12.11.1 (SQLite **3.53.2**), Python 3.9.6
(SQLite **3.43.2**), sqlite3 CLI **3.43.2**. Scripts under
`/Users/cyberdeth/.hermes/profiles/ceo/cache/scratch/dmprobe/`. Nothing below is estimated.

| # | Claim tested | Command | Observed |
|---|---|---|---|
| M1 | `cp` of a live `site.db` exports nothing | `python3 probe_copy2.py` | `main=4096 -wal=32992`; `naive cp main-only: FAILED: no such table: u_post` |
| M2 | A partial unique index cannot be an FK parent | `python3 probe_fk.py` | `D FK to PARTIAL unique index: ERROR -> foreign key mismatch - "u_product" referencing "cms_asset"` |
| M3 | FK matching uses the *parent* index collation | `python3 probe_fk2.py` | child BINARY `'Banner-Home'` vs parent NOCASE `'banner-home'`: `INSERT ACCEPTED`, `join a.key=p.cover: 1` |
| M3b | `PRAGMA foreign_keys` inside a transaction is a silent no-op | `python3 probe_fk2.py` | `fk8 before: 1 / fk8 inside txn after OFF: 1 / fk8 after commit: 1` |
| M4 | `NO ACTION` on update makes a referenced key immutable | inline probe `noaction.db` | `rename key used by u_post: REJECTED -> FOREIGN KEY constraint failed`; after refs removed: `ACCEPTED` |
| M5 | A table rebuild resets `sqlite_sequence` | `python3 probe_rebuild.py` | `seq before: [('u_post',5)]` → `seq after: [('u_post',3)]`, next id 4 |
| M6 | Without `AUTOINCREMENT` ids are reused | `python3 probe_rebuild.py` | `max(id)=3` after deleting 3 and inserting |
| M7 | `busy_timeout=0` loses most concurrent writes | `python3 probe_conc2.py` | `busy_timeout=0ms ok=50/200 busy=150`; `=5000ms ok=200/200 wall=71ms` |
| M7b | A held read snapshot pins the WAL | `probe_conc2.py`, `pin.db` | `wal_autocheckpoint=0` + held reader: `12,421,832 B` WAL / `8,192 B` main; default autocheckpoint: `201,912 B`; `PASSIVE -> (0,3015,3015)` leaves size, `TRUNCATE -> (0,0,0)` → 0 |
| M8 | Renaming a key with 200k references costs a write lock | `python3 probe_big.py` | settled db: `rename asset key with 200000 references (ON UPDATE CASCADE): 439 ms`; inside the inserting txn: `2412 ms` |
| M9 | `ATTACH` + `CREATE TABLE AS SELECT` exfiltrates a tenant | `node probe_exfil.js` | `ACCEPTED: ATTACH DATABASE …` `ACCEPTED: CREATE TABLE u_report AS SELECT …` → `exfiltrated rows: [{"issued_to_email":"buyer@acme.com"}]`; `after reopen`: same row |
| M9b | `ROLLBACK` does not undo `ATTACH` | `node probe_post3.js` | after rollback `dbs: [main, other]`; `same handle reads other tenant after rollback: [{"issued_to_email":"buyer@acme.com"}]`; after `DETACH`: `REJECTED -> no such table` |
| M10 | better-sqlite3 exposes no ATTACH limit; defensive mode blocks `writable_schema` | `node probe_ddl.js` | `db.setLimit? undefined \| db.db_config? undefined`; `PRAGMA writable_schema=ON` → value `0`; `UPDATE sqlite_master` → `table sqlite_master may not be modified` |
| M11 | Handle cost | `node probe_rss.js` | `200 handles: 138 ms (0.69 ms each), RSS delta 36.1 MB = 185 KB per handle`, 613 fds → 13 after close |
| M12 | Export primitives are cheap at scale | `python3 probe_big2.py` | `397.7 MB → VACUUM INTO 1472 ms`; `wal_checkpoint(TRUNCATE) 104 ms`; `integrity_check 276 ms`; `0.010 ms/row` insert |
| M13 | `journal_mode` is not preserved by `VACUUM INTO`; live pragma can be stale | `probe_export.py`, `ord_after_jm` | `copy jm=delete` for all three modes; `after_jm live=0 copy=2` |
| M14 | Eager migration fan-out is affordable | `node probe_migrate.js` | `200 tenants, 1 migration + VACUUM INTO backup each: 811 ms total (4.05 ms/tenant) ok=200 failed=0` |
| M15 | argon2id cannot be looked up by equality | `node probe_codes.js`, `scripts/model/verify_claims.py` | `verify` = 71.5, 75.2, 79.6, 84.7, 85.0, 91.3, 121.3 and **1126.4** ms across eight runs; `two hashes of the SAME code are equal? false`; `5000-code scan = 358–5632 s`; `HMAC lookup 0.55–3.40 ms` |
| M16 | A WAL database needs a writable *directory*, even readonly | `node probe_ro2.js` | `wal, dir555, {readonly:true} -> FAILED SQLITE_READONLY_DIRECTORY`; `delete-rollback, dir555 -> OK rows=1` |
| M17 | A plausible key CHECK accepts `../` | `node probe_post3.js` | `"../etc/passwd" ACCEPTED` (first CHECK); with DM3's CHECK: `REJECTED`. Symlink: `symlink with '../' in name: CREATED`, `realpath` outside `content/public` |
| M18 | FK child columns are not auto-indexed, and it costs 50× | `python3 probe_fkidx.py` | `no index: 21.55 ms` / `index: 0.43 ms`, plan `SCAN u_ch` vs `SEARCH u_ch USING COVERING INDEX` |
| M19 | Surrogate keys are not smaller for a key-only table | `python3 probe_size.py` | `INTEGER PK + UNIQUE(key): 56.2 B/row`; `TEXT PK WITHOUT ROWID: 35.7 B/row` |
| M20 | The schema applies cleanly and rejects what it must | `python3 scripts/model/validate_schema.py` | `site.db: 20 tables, 13 explicit indexes, 14 FK clauses, integrity=ok, fk_check=0`; 12/12 negative tests rejected; empty `site.db` = 225,280 B |
| M21 | `VACUUM INTO` is consistent against a live write transaction, but fails from inside one | inline probe `vac_live.db` | `copy rows: 500 … uncommitted present: 0`; `VACUUM INTO on the writing connection: FAILED -> cannot VACUUM from within a transaction` |

Raw output for the three load-bearing measurements, verbatim. Two figures needed correction when
re-run by `scripts/model/verify_claims.py`, and both corrections are substantive, not cosmetic:
the argon2 verify cost spans **70 ms to 1.13 s** across eight runs on the same machine (it tracks
machine load, so it is quoted as a range with no floor claimed, and the scan as 358 s – 1.6 h), and the key-rename
cost is **439 ms** on a settled database versus 2,412 ms measured inside the transaction that
inserted the 200,000 rows — both reported in M8. Every other figure reproduced to the digit.

```
$ python3 probe_copy2.py
live sizes: {'main': 4096, '-wal': 32992, '-shm': 32768}
live read: rows=1000 integrity=ok
naive cp main-only          : FAILED: no such table: u_post
cp main + -wal              : rows=1000 integrity=ok
VACUUM INTO (writer open)   : rows=1000 integrity=ok
wal size after TRUNCATE ckpt: 0
cp main after checkpoint    : rows=1000 integrity=ok
```

```
$ node probe_exfil.js
ACCEPTED: ATTACH DATABASE '/…/victim_site.db' AS victim
ACCEPTED: CREATE TABLE u_report AS SELECT id, code_hash, issued_to_email FROM victim.cms_download_code
exfiltrated rows in attacker db: [{"id":1,"code_hash":"argon2id$abc","issued_to_email":"buyer@acme.com"}]
after reopen, u_report rows: [{"id":1,"code_hash":"argon2id$abc","issued_to_email":"buyer@acme.com"}]
```

```
$ node probe_codes.js
argon2id hash: 116.2 ms | verify: 121.3 ms | ok=true
two hashes of the SAME code are equal? false
insert 5000 code rows: 16 ms
scan-verify 10 rows: 1226 ms -> 122.6 ms/row
  finding 1 code among 5000 by scan = 612.8 s per attempt
HMAC-SHA256 lookup: 0.560 ms -> UNIQUE index seek, O(log n)
```

### M21 — `VACUUM INTO` on a live database with an open write transaction

The export path is the one place a torn snapshot would ship to a client, so I tested it rather than
trusting the documentation:

```
committed rows: 500
uncommitted rows present on writer: 550
reader mid-txn sees: 500 (WAL snapshot isolation)
VACUUM INTO while a write txn is open: OK in 1 ms
  copy rows: 500 | integrity: ok | uncommitted present: 0
VACUUM INTO on the writing connection: FAILED -> cannot VACUUM from within a transaction
after commit, first copy still has: 500 rows (snapshot taken mid-txn)
```

Two conclusions, both of which go into the SDS as requirements:

1. `VACUUM INTO` from a **separate connection** produces a consistent snapshot that excludes
   uncommitted rows — so export may run against a live site without a maintenance window.
2. `VACUUM INTO` on a connection that holds a transaction **fails outright**. The exporter therefore
   needs a dedicated, short-lived connection that never runs in a transaction; reusing the pooled
   write handle is a runtime error, not a degraded mode.

