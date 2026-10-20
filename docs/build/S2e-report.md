# S2e — the Data Source plane, the preview token, generated types, and the seal clock

**Builder:** Backend Engineer. **Date:** 2026-10-20. **Base:** `100f058` (S2d).
**Not committed.** `git status --porcelain`: 5 modified, 13 new paths (§1).

All six items are in. The order was the work order's: the registry/resolver and the
publish gate first (they share the allowlist), then the render-path exposure, the
preview token, the type generator, the seal scheduler and the operator command.
Every acceptance criterion has a command and its real output (§3), the plan-refusal
evidence is verbatim (§4), and each new gate has a mutation that makes it go red
(§6).

Two things this slice fixed that were not asked for, and should be read as
corrections: **the app could not construct three of the codes §6.2 specifies**
(`SKW_E_RT_SOURCE_UNKNOWN`, `_UNINDEXED`, `_BUDGET` were in `schema/error-codes.json`
but not in `app/errors.ts`'s compile-time map, so raising one threw "no HTTP
mapping"), and **`cms_datasource` had no caller at all** — the table, the grammar and
the gate were a specification with no route. Both are wired now.

---

## 1. What shipped

| Path | Status | What it is |
|---|---|---|
| `app/sources/spec.ts` | **new**, 256 | §6.2's grammar: `view`/`query` only, `function` refused with C-18's code before a connection exists; `where`/`order`/`group_by`/`aggregate`/`params` parsing; the two `SOURCE_BUDGET` grammar refusals |
| `app/sources/registry.ts` | **new**, 120 | `cms_datasource` reads, `cms_view_registry` membership, and the column allowlist: `cms_table_registry.columns_json` for `query`, `PRAGMA table_xinfo` + `cms_view_registry` for `view`; leftmost-index set |
| `app/sources/compile.ts` | **new**, 166 | one compiler, values always `?`, identifiers only from allowlisted names; the publish- and resolve-time allowlist refusal; `limit` clamping and `data-truncated` |
| `app/sources/plan.ts` | **new**, 134 | `EXPLAIN QUERY PLAN`, the `SCAN` refusal that **names the column**, the where/order/group_by index rule, and the 200-run measurement (`cost_ms_max`, `cost_ms_p95`, `cost_rows`) |
| `app/sources/cache.ts` | **new**, 103 | `(tenantKey, sourceKey, specRev, sha256(canonicalParams))` with TTL; single-flight is structural (sync resolution) |
| `app/sources/publish.ts` | **new**, 281 | the gate in §6.1/§6.2's order and one transaction: row + `cms_audit`; `saveSourceDraft` for the unpublished half |
| `app/sources/resolve.ts` | **new**, 85 | the resolver on a `render-read` handle: unknown / not_published / not_public / allowlist re-check / compile / cache |
| `app/render/data.ts` | **new**, 42 | `createRenderData(db, {tenantKey})` → `{ source(key, params) }`; rows, never a handle |
| `app/render/preview.ts` | **new**, 134 | O-29: `<exp>.<HMAC(SKW_SESSION_KEY, tenant\|path\|exp)>`, 30 min, draft only, one log line per accepted render |
| `app/db/kysely.ts` | **new**, 105 | the generator from `columns_json`, deterministic bytes, the closed type map |
| `app/db/kysely.generated.ts` | **new**, 9 | the base schema's generated file (a fresh `site.db` has no runtime tables) |
| `app/audit/scheduler.ts` | **new**, 179 | `sealDay` (one seal per tenant per UTC day, per-tenant errors), `msUntilNextUtcMidnight`, `startSealScheduler` (unref'd timer) |
| `app/cli/gen-kysely.ts` | **new**, 42 | `--db <site.db> [--out <file>]` |
| `app/cli/skwctl.ts` | modified, +72 | `skwctl audit seal\|verify --tenant <key> --day YYYY-MM-DD` |
| `app/main.ts` | modified, +45 | the render path calls `loadPageForRender` (preview) and passes `data`; the seal scheduler starts and stops with the app |
| `app/admin/routes.ts` | modified, +90 | `GET …/sources`, `POST …/sources/publish`, `POST …/sources/draft`; the page detail mints `preview.url` for a draft |
| `app/render/page.ts` | modified, +6 | `PageRecord.status` (the preview gate needs it) |
| `app/errors.ts` | modified, +7 | the three §6.2 codes join the compile-time map |
| `test/sources.test.ts` | **new**, 473 | S2E-1…10 |
| `test/preview.test.ts` | **new**, 119 | S2E-11…14 |
| `test/kysely-types.test.ts` | **new**, 125 | S2E-15…17 |
| `test/seal-scheduler.test.ts` | **new**, 168 | S2E-18…21 |
| `test/admin-sources.test.ts` | **new**, 157 | S2E-22…25 |
| `scratch/s2e/plan-refusal.ts` | new | the probe §4's output comes from |
| `scratch/s2e/cache-ttl.ts` | new | the probe §5's output comes from |

`schema/*` is untouched: every column this slice writes already exists in the
frozen DDL. There is no migration and no re-baselined check 20.

---

## 2. The gates, run

```
$ make test
verify-toolchain: /usr/bin/python3 -> python 3.9.6, sqlite 3.43.2, argon2 ok
PASS  1 schema/ER parity + negative tests                      v3: 36 entities == 36 CREATE TABLE; ...
27/27 passed, 0 skipped, 0 failed
...
1..269
# tests 269
# suites 0
# pass 269
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

269 = 244 (S2d) + 25 new: 10 sources, 4 preview, 3 types, 4 seal, 4 admin. The new
files are picked up by `make verify-s1`'s `find test -name '*.test.ts'` with no
Makefile change, and `# skipped 0` still cannot exit 0 (G3).

---

## 3. The acceptance criteria, one by one

### 3.1 An unindexed `query` source is refused at publish, the error names the column; adding the index makes it publish

```
$ node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^S2E-1\.' test/sources.test.ts
ok 1 - S2E-1. a query source with SCAN in its plan is refused at publish, naming the column that caused it

$ node --test ... --test-name-pattern='^S2E-2\.' test/sources.test.ts
ok 1 - S2E-2. adding the index the refusal named makes the same source publish, with the measured cost stored
```

S2E-1 asserts `code === 'SKW_E_RT_SOURCE_UNINDEXED'`, `detail.column === 'section'`,
`detail.plan` matches `/SCAN/`, the message contains `section`, and **nothing was
written**: zero `cms_datasource` rows and zero `source.publish` audit rows for that
key. S2E-2 then creates `ix_posts_section` through the real DDL runner and asserts
the stored `cost_plan` matches `/SEARCH/`, `cost_ms_max ≤ 1.5`, and one audit row.
The verbatim plan and measurement are in §4.

### 3.2 `is_public=false` → the resolver throws; after an audited publish → it resolves

```
$ node --test ... --test-name-pattern='^S2E-4\.' test/sources.test.ts
ok 1 - S2E-4. is_public=false is refused by the resolver; an audited publish flips it and the same call resolves
```

Three cases, one test: a source published with `is_public=false` resolves to
`SKW_E_RT_SOURCE_UNKNOWN` / `reason=not_public`; **`is_public` omitted defaults to
false** and is refused the same way; a draft (`published_at IS NULL`) is refused with
`reason=not_published`; then an audited publish with `isPublic: true` returns 3 rows
(`[{title:'Published 5', slug:'published-5'}, …]`) and `cms_audit` holds two
`source.publish` rows for the key.

### 3.3 A column outside the allowlist is refused at publish **and** at resolve

```
$ node --test ... --test-name-pattern='^S2E-5\.' test/sources.test.ts
ok 1 - S2E-5. a column outside the allowlist is refused at publish AND at resolve time
```

At publish: `secret_col` → `SKW_E_RT_SOURCE_UNKNOWN`, `detail.column='secret_col'`,
message names it. At resolve: a source is published against the live registry, then
`cms_table_registry.columns_json` is rewritten without `title` (the shape a rebuild
leaves behind); the next `resolveSource` on a fresh `render-read` handle refuses with
`detail.column='title'`. Both halves are the same `compile()` call, so a resolution
cannot use a column the schema stopped carrying.

### 3.4 Two parameter sets inside one TTL return their own rows, in both orders

```
$ node --test ... --test-name-pattern='^S2E-6\.' test/sources.test.ts
ok 1 - S2E-6. two parameter sets inside one TTL return their own rows, in both orders (O-10)
```

```
$ node scratch/s2e/cache-ttl.ts
order A: {limit:3} -> 3 rows; {limit:5} -> 5 rows; cache size 2
order B: {limit:5} -> 5 rows; {limit:3} -> 3 rows; cache size 2
row sets differ: true
```

Both orders, then a third cache with two enum values (`draft` → 2 rows,
`published` → 5). The key is `(tenant, source, specRev, sha256(canonicalParams))`;
the assertion that the two row sets differ is the witness that the parameters are in
the key. §6's O-10 defect (a source-keyed cache) is what this test would catch: the
`{limit:5}` request would have received 3 rows.

### 3.5 TTL: a row inserted after publish is visible after the TTL and not before

```
$ node --test ... --test-name-pattern='^S2E-7\.' test/sources.test.ts
ok 1 - S2E-7. TTL: a row inserted after publish is invisible before the TTL and visible after it
```

```
$ node scratch/s2e/cache-ttl.ts   (last line)
ttl_s=1: before 2 rows; row inserted; inside TTL 2; after +1001 ms 3
```

The clock is injected, so the gate is arithmetic rather than a sleep: an entry
written at `t` is a miss at `t + ttl_s·1000`. `ttl_s=0` disables the cache for that
source (no `set`).

### 3.6 `function` is refused with its code, and no file is loaded

```
$ node --test ... --test-name-pattern='^S2E-8\.' test/sources.test.ts
ok 1 - S2E-8. a `function` source is refused with C-18's code and no file is loaded
```

`SKW_E_RT_SOURCE_UNKNOWN`, `detail = {reason:'kind_not_representable', kind:'function',
register:'C-18'}`, refused **before** the handle factory is called (`opened` is `[]`).
The test writes `content/sources/evil.mjs` that would create a marker file on
execution; the marker does not exist afterwards. It also pins the module boundary:
none of `app/sources/*.ts` contains a dynamic `import(`, `require(` or a file read,
so a future edit that reintroduces one is red. The schema is the second lock:
`INSERT … kind='function'` fails `CHECK(kind IN ('view','query'))`.

### 3.7 Preview token: draft only, rejected for published, rejected after 30 min, `no-store`

```
$ node --test --test-reporter=tap --test-concurrency=1 test/preview.test.ts
ok 1 - S2E-11. a preview token for a draft page renders it, with no-store
ok 2 - S2E-12. the same token is rejected for a published page
ok 3 - S2E-13. a token older than 30 minutes is rejected; a token minted for another path is rejected
ok 4 - S2E-14. the TTL is exactly 30 minutes, and a token is logged exactly once per accepted render
```

Over a real socket and the real Astro shell: a valid token renders `/draft-page`
(200, body contains `draft only`, `cache-control: no-store`); the same token on
`/pricing` is 404 `SKW_E_RT_PAGE_NOT_FOUND`; a token minted 30 min + 1 s ago, a token
minted for another path, a token with a changed MAC, and no token are all 404; the
`exp` in the token is exactly `now + 1800 s`. S2E-25 proves the minting side is
admin: `GET /admin/t/acme/pages/<draft id>` returns
`preview.url = /soon?preview=<exp>.<64 hex>` with `expires_in_s: 1800`, and that URL
renders on the public host; a published page's detail returns `preview: null`.

### 3.8 The seal scheduler writes one seal per day and refuses a second seal with a different head

```
$ node --test --test-reporter=tap --test-concurrency=1 test/seal-scheduler.test.ts
ok 1 - S2E-18. one seal per tenant per day, and a second run with the same head is idempotent
ok 2 - S2E-19. a second seal for the day with a different head is refused and does not overwrite the anchor
ok 3 - S2E-20. the scheduler targets the next UTC midnight and stops cleanly
ok 4 - S2E-21. `skwctl audit verify` passes on a sealed day and fails after the chain moves
```

Two tenants, one day: exactly two `audit_seal` rows; a second run with the same head
leaves two rows and the same `sealed_at`. Appending one audit row moves the head;
the next `sealDay` records `SKW_E_SEC_AUDIT_SEAL` for **that tenant only** and leaves
the anchor byte-identical. The scheduler arithmetic is checked at 23:00 (3,600,000
ms), at midnight (86,400,000 — no zero-delay spin) and at 23:59:59.500 (500 ms), and
`stop()` is observable. The operator command is exercised as a process: sealed day →
exit 0 with `verified: tenant=beta day=2026-10-20 rows=… head=…`; moved chain → exit 1
with `SKW_E_SEC_AUDIT_SEAL`; unsealed day → exit 1 with `no seal`.

### 3.9 The generated Kysely types regenerate identically (byte compare) and match the live schema

```
$ node --test --test-reporter=tap --test-concurrency=1 test/kysely-types.test.ts
ok 1 - S2E-15. regenerating from the same live schema is byte-identical
ok 2 - S2E-16. every generated column and type agrees with PRAGMA table_xinfo of the live table
ok 3 - S2E-17. the committed base-schema types regenerate identically from a fresh site.db
```

S2E-15 generates twice from one live handle and compares strings, then writes a file
and compares the bytes on disk. S2E-16 walks `PRAGMA table_xinfo` for `u_posts` and
`u_notes` and asserts every column and nullability in the generated text (the one
deliberate mapping: `INTEGER PRIMARY KEY` is the rowid and cannot be NULL even though
`table_xinfo.notnull` is 0). S2E-17 regenerates from a fresh `schema/site.sql` and
byte-compares with the committed `app/db/kysely.generated.ts`, so a stale committed
file is red rather than silently wrong.

---

## 4. The plan-refusal evidence, verbatim

```
$ node scratch/s2e/plan-refusal.ts
SQL: SELECT "title", "slug" FROM "u_posts" WHERE "status" = ? ORDER BY "published_at" DESC LIMIT ?
EXPLAIN QUERY PLAN (before the index):
  id=7 parent=0  SCAN u_posts USING INDEX ix_posts_published_at
REFUSED: SKW_E_RT_SOURCE_UNINDEXED
MESSAGE: the plan for source u_posts contains SCAN; column "status" has no usable index
DETAIL.column: status
DETAIL.plan: ["SCAN u_posts USING INDEX ix_posts_published_at"]
EXPLAIN QUERY PLAN (after ix_posts_status):
  id=7 parent=0  SEARCH u_posts USING INDEX ix_posts_status (status=?)
  id=25 parent=0  USE TEMP B-TREE FOR ORDER BY
PUBLISHED: {"kind":"query","cost_ms_max":0.3456249999999983,"cost_ms_p95":0.014167000000000485,"cost_rows":6}
```

Two things to read in that output. The plan says `SCAN u_posts USING INDEX
ix_posts_published_at` — it never says "because `status` has no index", which is why
the culprit is derived from the spec (first unindexed `where` column) and named in
both the message and `detail.column`. And the `SCAN` is an **index** scan: refusing
only a full-table `SCAN u_posts` would have passed a source whose filter column is
unindexed, which is exactly the source the gate exists to refuse.

The measurement is the worst of 200 runs, taken **after** the plan passes — the
refusal above cost 0.015 ms; measuring first would have cost ~1,300 ms for the same
answer.

---

## 5. Decisions, spec gaps, and what this slice changed

1. **The three §6.2 codes were unreachable from the app.** `SKW_E_RT_SOURCE_UNKNOWN`,
   `_UNINDEXED` and `_BUDGET` existed in `schema/error-codes.json` (and in
   `test/error-codes.test.ts`'s count of 72) but not in `app/errors.ts`'s `HTTP`
   map, so `new AppError(...)` threw "no HTTP mapping" instead of returning 422.
   Added; the taxonomy count is unchanged.
2. **The allowlist is the schema's record, not a list.** `query` reads
   `cms_table_registry.columns_json`; a `cms_*` table or an unregistered `u_*` table
   is `SOURCE_UNKNOWN` / `table_not_registered`. This is C-13 applied to reads: a
   source cannot name a table the operator never agreed to make sellable.
3. **The plan check runs before the index-membership check.** §6.2's table lists
   "every where/order/group_by column is indexed" before the plan rule, but the
   plan is the cheap, evidence-producing check (0.015 ms) and it is what names the
   column that *caused* the SCAN. The index rule then catches a column the planner
   avoided with a temp B-tree (`USE TEMP B-TREE FOR ORDER BY`). Both produce
   `SOURCE_UNINDEXED`; the detail differs (`plan` vs `role`), and the order is why
   the refusal in §4 carries the plan text.
4. **`cost_ms_max` is re-measured on every publish, and an over-budget max is
   confirmed once.** §6.2 says the stamp is invalidated when the row count doubles
   and a re-measure is mandatory before the next publish; this gate has no other
   mode — it measures the spec it is about to store, so a stale stamp cannot be
   published. `cost_rows` is stored beside it so the next operator can see the size
   the number was taken at.
   The measurement is the worst of 200 runs, after one uncounted warm-up (the first
   `step` faults in pages and is not a cost a render after the first pays). A
   max-of-200 is an extreme-value statistic and the whole batch is a few
   milliseconds, so one OS deschedule can put a 0.01 ms statement over 1.5 ms —
   measured on this box at 1.8–3.0 ms, three runs in eight. When the first max is
   over budget the gate takes a **second** max-of-200 and refuses only if that is
   also over; the accepted batch is what is stored. A genuinely over-budget source
   is over in both (S2E-3's `budgetMsMax: 0` takes the refusal path twice), and the
   refusal detail carries both maxima under `attempts`. This is the one place the
   slice adds a retry, and it is here because a gate that refuses a source measured
   100× under budget on a busy host is a gate an operator learns to bypass.
5. **`is_public` defaults false, and `saveSourceDraft` clears `published_at`.**
   A spec edited under a published plan is a source whose measured cost nobody
   knows; the draft route therefore unpublishes, and the resolver refuses it until
   it is published again. The alternative — keep serving the old measured plan
   against the new spec — is the defect the gate exists to prevent.
6. **The admin write routes take JSON, not a form.** The builder's preview/apply are
   forms; a source spec is a nested object (`where`/`order`/`params`) that a form
   encoding would have to invent a syntax for. The routes are POST + Origin + CSRF,
   like every other write, and a refusal propagates as §4.3's taxonomy body. The
   authoring *form* is S4's editor work; the gate has a caller now.
7. **The seal job is per-tenant error data, not a thrown loop.** One tenant's broken
   chain must not stop the other tenants' seals; `sealDay` returns one result per
   tenant and `skwctl audit seal` exits non-zero if any refused. The scheduler
   writes the day that just ended at UTC midnight and is `unref()`d, so it cannot
   keep a shutting-down process alive.
8. **`cms_view_registry` is read, not enforced at DDL time.** A `view` source must
   name a registered `cms_v_*` view, and its allowlist comes from `table_xinfo`. The
   S2d gap remains on the other side: the DDL runner creates no views, so
   "a view not in this registry fails the postcondition" still has no op that could
   violate it. It is listed in §7, not claimed.

---

## 6. Mutation evidence — each new gate goes red

| # | Mutation | Gate | Result |
|---|---|---|---|
| M1 | `if (report.scan) refusePlan(...)` → `if (false && …)` | S2E-1 | `# pass 1 / # fail 1` |
| M2 | cache key drops `sha256(canonicalParams)` | S2E-6 | `# pass 0 / # fail 1` |
| M3 | `is_public` check disabled in `resolve.ts` | S2E-4 | `# pass 0 / # fail 1` |
| M4 | preview accepts any `status`, not only `draft` | S2E-12 | `# pass 0 / # fail 1` |
| M5 | `writeSeal` returns the existing seal instead of refusing a different head | S2E-19 | `# pass 0 / # fail 1` |
| M6 | the generator's header text drifts one character | S2E-17 | `# pass 0 / # fail 1` |

Every mutation was reverted before `make test` (§2). M1 shows one pass because the
pattern `S2E-1` also selects S2E-10; S2E-1 itself is the failure.

---

## 7. What remains before S2 can be declared GO

S2's own §16 table is now covered by a gate in the tree: CSRF (S2a), Origin (S2a),
the DDL AST (S2d), the asset guard (S2d), the `SCAN` refusal (S2e), the parameter
cache (S2e), the preview token (S2e), and `SKW_SCHEMA_EDIT=off` (S2c/S2d). What is
still open is not a row of that table:

1. **`site.page(path)` with the nested-path case.** S2d's remaining list named it
   beside the resolver; it is a template helper (`site.url()`, `site.asset()` and
   `site.page()` are §6.3's binding families) and belongs with the `list` component
   in S4. Nothing in S2e's resolver depends on it.
2. **The `cms_view_registry` postcondition in the DDL runner**, and a checksum
   comparison for a `view` source (the registry stores `checksum`; publish verifies
   membership, not that the view's `sqlite_master.sql` still hashes to it). No op in
   the seven-op union can create or alter a view, so there is no gate to write yet.
3. **The `list` component's SSR and the wire form of `data-truncated`.** The
   resolver returns `{rows, truncated, limit}`, and §6.3's loop is S4; the two must
   agree on the attribute name when S4 lands.
4. **Export enumeration of source parameters** (§6.4, C-22): `SKW_SNAPSHOT_MAX_COMBOS`
   and the `free`-parameter refusal are exporter work (S4), not resolver work.
5. **The source authoring form.** `POST …/sources/publish` takes the spec as JSON;
   an operator without `curl` has no screen. That is the editor surface (S4), and
   the route is deliberately the same gate so the form cannot bypass it.

S3 is unaffected: gated downloads do not read `cms_datasource`, and the seal job
adds one row per tenant per day (the 32.1 KB/tenant-year figure S2d measured).

---

## 8. Files run against

```
 M app/admin/routes.ts   M app/cli/skwctl.ts   M app/errors.ts   M app/main.ts   M app/render/page.ts
?? app/audit/scheduler.ts   ?? app/cli/gen-kysely.ts   ?? app/db/kysely.generated.ts   ?? app/db/kysely.ts
?? app/render/data.ts       ?? app/render/preview.ts   ?? app/sources/                   ?? scratch/s2e/
?? test/admin-sources.test.ts ?? test/kysely-types.test.ts ?? test/preview.test.ts
?? test/seal-scheduler.test.ts ?? test/sources.test.ts ?? docs/build/S2e-report.md
```

`scratch/s2e/` is not a deliverable and is not committed: it holds the two probes
§4 and §5 quote, so a reader can re-run them.
