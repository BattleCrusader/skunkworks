# S2c — the IP allowlist (E-17), the CRUD write path, the table builder's scaffold

**Builder:** Backend Engineer. **Date:** 2026-10-20. **Base:** `8e5d1c1` (S2b GO).
**Not committed.** `git status --porcelain`: 13 modified, 8 new paths (§1).

Scope, in the order the work order gives it: **E-17 in full (item 1)**, **the CRUD write path
with audit (2)**, **the table builder scaffold (3)**. All three are in. Item 3 stops exactly
where S2d starts: the form and the preview, no executor.

Every criterion below has a command and its real output. Every new gate also has a **mutation
that makes it go red** (§5), because a test that has never failed is not evidence.

---

## 1. What shipped

| Path | Status | What it is |
|---|---|---|
| `app/admin/allowlist.ts` | new, 147 | **the** `SKW_ADMIN_ALLOWLIST` parser: unset/empty, CIDR validation, `AllowlistParseError` naming the token (§9.1a) |
| `app/env.ts` | modified | `SKW_ADMIN_ALLOWLIST` as the 23rd name; `adminHostOf` now normalises; `demosHostOf` derived (§9.1a) |
| `tools/nginx_gen.ts` | modified | imports the parser; `allow`/`deny` in the admin block only; `SKW_ADMIN_HOST`/`SKW_DEMOS_HOST` **deleted**, hosts derived from `SKW_ADMIN_ORIGIN` |
| `app/admin/routes.ts` | modified, +377 | `tables/…` CRUD forms (§9.3) and `builder`/`builder/preview` (§9.4); allowlist read from `env.adminAllowlist` |
| `app/admin/crud.ts` | new, 401 | the write half of §9.3: generated-column forms, `admin-write` only, one `cms_audit` row per change in the same transaction, SQLite → taxonomy mapping |
| `app/ddl/emit.ts` | new, 175 | §4.4's `create_table` → the exact SQL, plus the two refusals that apply at create time |
| `app/ddl/form.ts` | new, 103 | the builder's form grammar (`<name> <TYPE> [NOT NULL] [DEFAULT …] [RELATION=u_…]`) |
| `app/errors.ts` | modified | `DM` codes the write path can receive: `KEY_IN_USE`, `FK_VIOLATION`, `COLUMN_IMMUTABLE`, `ASSET_IN_USE` (409) and `DDL_REJECTED` (422) |
| `app/main.ts` | modified | `adminAllowlist` build option deleted (the env is the only storage); `accessLogPath` seam for E-17's gate |
| `docker-compose.yml`, `install.sh`, `.env.example` | modified | `SKW_ADMIN_ALLOWLIST`, empty in every exported bundle |
| `scripts/proof/allowlist-single-parser.mjs` | new | the shared-parser proof: mutate one accepted range, both consumers move, sha-verified restore |
| `test/admin-allowlist.test.ts` | new, 10 tests | E-17's parsing cases, the derived TOTP/idle consequences, and the one-module assertion |
| `test/admin-crud.test.ts` | new, 11 tests | forms, create/edit/delete + audit, refused writes, render-read ban, tenant isolation, CSRF |
| `test/admin-builder.test.ts` | new, 9 tests | the emitter, `SKW_SCHEMA_EDIT=off`, the preview == emitter output, nothing executed |
| `test/env.test.ts`, `test/nginx-config.test.ts`, `test/nginx-e2e.test.ts`, `test/admin-auth.test.ts`, `test/onboarding.test.ts` | modified | E-17's named cases; the allow/deny placement; the real-nginx 403; the allowlist moved from a build option to the env |

`schema/*` is untouched: E-17 stores the allowlist in the environment and §9.3's writer uses
the tables that already exist (`cms_audit`), so there is no migration, no `gen_schema.py` bump
and no re-baselined check 20.

---

## 2. The gates, run

```
$ make test
verify-toolchain: /usr/bin/python3 -> python 3.9.6, sqlite 3.43.2, argon2 ok
27/27 passed, 0 skipped, 0 failed
adopted sentences: 24/25 verbatim in SDS.md; 1 superseded by 02-errata
frozen §4 blocks: 11/12 verbatim; 1 superseded by 02-errata
resolution steps: 5/5 present; env names: 29/29 present
PASS the SDS quotes the register
# tests 215
# pass 215
# fail 0
# skipped 0
EXIT=0
```

215 = 176 (S2b) + 39 new: 10 allowlist, 3 env, 4 nginx-config, 2 nginx-e2e, 11 CRUD, 9 builder.
`# skipped 0`, and since G3 a skip cannot exit 0 anyway.

Baseline measured before any edit: `# tests 176 # pass 176 # fail 0 # skipped 0`, `make test`
exit 0.

`hermes verify --json` — the full harness including a runtime boot — on the delivered tree:

```
{"recipe":"Astro","ok":true,
 "phases":[bootstrap 0, build 0, "npm run typecheck" 0, "npm run test" 0 (215/215),
           "make test" 0 (215/215), "make typecheck" 0, "make build" 0],
 "readiness":{"url":"http://127.0.0.1:4321/","ready":true,"statusCode":200}}
```

**One flake, reported rather than smoothed over.** Of five full `make test` runs, one failed the
pre-existing E-16 timing gate (`admin-auth.test.ts` case 4) with
`{"wrong_password":40.42,"unknown_email":31.20,"wrong_totp":40.66} (ratio 1.303)`; the file passed
3/3 in isolation immediately afterwards and the next two full runs were green. The gate compares
medians of 20 samples under a 20 % band, and the failing run was sharing the box with this slice's
build and Docker gate. The threshold and the sample count are **untouched** — weakening a gate to
go green is the one thing this slice may not do — so the honest statement is: this test is
load-sensitive, it is S2b's, and it is worth a wider band or a quieter runner only if it
reproduces in CI.

---

## 3. Acceptance criteria

### 3.1 Empty allowlist → TOTP required and no access directive; populated → `allow`/`deny` and TOTP optional

```
$ node --test --test-reporter=tap test/admin-auth.test.ts
ok 1 - 0. the allowlist decides both consequences §9.1 states: TOTP and the idle window
ok 3 - 2a. TOTP is mandatory when the allowlist is empty: no code and a wrong code are both 401
ok 5 - 3. TOTP is not required when the allowlist is populated
# tests 12  # pass 12  # fail 0
```

`test/admin-auth.test.ts:71` now sets `SKW_ADMIN_ALLOWLIST=10.0.0.0/8` in the **environment**
instead of passing `buildApp({adminAllowlist})` — the build option is deleted, so there is no
second way to set the value.

```
$ node --test --test-reporter=tap test/nginx-config.test.ts
ok 13 - E-17: with the list empty the admin block emits neither allow nor deny, and no block does
ok 14 - E-17: a populated list emits one `allow` per block plus `deny all;` in the admin block only
ok 15 - E-17: the admin and demos hosts are derived from SKW_ADMIN_ORIGIN, and the old env names are gone
ok 16 - E-17: the generator refuses a malformed allowlist from the same parser, with the same message
# tests 16  # pass 16  # fail 0
```

The empty case asserts `generated.includes('deny') === false` for the whole of `10-app.conf` —
"no accidental `deny all`" is asserted against the file, not only the admin block. The populated
case asserts each `allow` line, the `deny  all;`, their order before the first `location`, and
that **no tenant block and no demos block** carries either directive.

### 3.2 A denied peer is 403 at the edge and the app never sees the request

```
$ node --test --test-reporter=spec test/nginx-e2e.test.ts
✔ E-17: a peer outside SKW_ADMIN_ALLOWLIST is nginx's 403, and the app never sees the request (4.070333ms)
✔ E-17: the same request from a peer inside the list reaches the app (7.08825ms)
ℹ tests 13  ℹ pass 13  ℹ fail 0  ℹ skipped 0
```

Real nginx 1.31-alpine, three containers over one app, differing only in the allowlist:

- `denyPort` — `SKW_ADMIN_ALLOWLIST=203.0.113.0/24` (the test peer is not in it);
- `allowPort` — `SKW_ADMIN_ALLOWLIST=<the peer nginx actually sees>/32`, measured from a
  `return 200 "$remote_addr"` probe rather than assumed (the container sees the bridge gateway,
  not `127.0.0.1`);
- `edgePort` — empty list, the other 11 e2e cases.

The denied request asserts **403**, `Content-Type: text/html`, `res.json === undefined`, no
`SKW_E_` in the body, no `Set-Cookie` — E-13's fifth exception, exactly as E-17 words it. Then
it reads the app's own access log:

```
const before = logLines().length;
const res = await call({ port: denyPort, path: '/admin/login?denied=1', host: 'admin.skw.test' });
...
assert.equal(lines.length, before, `the app recorded the denied request: ...`);
assert.equal(lines.some((l) => l.includes('denied=1')), false, 'the denied request reached the app');
```

and the allowed twin asserts `logLines().some(l => l.includes('allowed=1'))`. **The witness is
the app**, not the edge: a 403 from nginx that had also proxied the request would still be
caught. The log is a build option (`accessLogPath`), not an environment name — §4.3 stays at 23.

### 3.3 CRUD create/edit/delete writes an audit row with actor and before/after; a failed write writes none

```
$ node --test --test-reporter=tap test/admin-crud.test.ts
ok 1 - CRUD-3. the CRUD pages are server-rendered, and the edit form has one control per editable column
ok 2 - CRUD-4. create writes the row and one audit row carrying actor, before=null and after
ok 3 - CRUD-5. edit writes before and after, and the row chains onto the previous hash
ok 4 - CRUD-6. delete removes the row and records what it was
ok 5 - CRUD-7. a write the schema refuses is a taxonomy 400, and writes no audit row
ok 6 - CRUD-8. delete of a row another table references is the taxonomy 409, not a 500
ok 7 - CRUD-9. a unique-key collision is SKW_E_DM_KEY_IN_USE, not a 500
ok 8 - CRUD-10. a write on the render-read class throws, and nothing is written
ok 9 - CRUD-11. the write path never opens render-read and never retries
ok 10 - CRUD-12. the same write against another tenant is refused before any row is touched
ok 11 - CRUD-13. a CRUD write without the CSRF header is 403
# tests 11  # pass 11  # fail 0
```

Asserted on the real `site.db` after the request:

- `actor_label` is the operator's `user_account.email`; `action` is `cms_page.create|update|delete`;
  `target_kind`/`target_id` name the row; `before_json` is `null` on create, the old row on update
  and delete; `after_json` is `null` on delete;
- `hash` is 64 hex characters and `prev_hash` equals the previous row's `hash` — the chain is a
  chain, asserted row-to-row;
- **CRUD-7**: a CHECK violation (`status='not-a-status'`) is `400 SKW_E_PLT_REQUEST_INVALID`, the
  row is absent **and the audit count is unchanged** — the audit insert is inside the same
  transaction, so the rollback takes it;
- **CRUD-8**: an asset referenced by `cms_asset_link` is refused by
  `trg_cms_asset_delete_guard`; the trigger's `SKW_E_DM_ASSET_IN_USE` is the code on the wire
  (409), the row survives and no audit row is written. Before `app/errors.ts` carried that code
  the same request was a **500** — that is the mutation M4 in §5.

### 3.4 A write on the render-read connection throws and is not retried

```
ok 8 - CRUD-10. a write on the render-read class throws, and nothing is written
ok 9 - CRUD-11. the write path never opens render-read and never retries
```

Three assertions, each at a different level:

1. `openRenderRead(file).prepare('INSERT …').run()` throws `attempt to write a readonly database`,
   and so does the same write after `PRAGMA query_only = 0` — §2.2's class has two halves and
   both hold;
2. the row is absent afterwards;
3. `app/admin/crud.ts` contains no `openRenderRead`, no `retry`, no `while (` — structurally,
   a failed statement cannot be re-run by this module.

M5 (§5) hands the write path a `render-read` handle and six CRUD tests go red: the ban is
load-bearing, not decorative.

### 3.5 The shared-parser proof

See §4. Short form: `node scripts/proof/allowlist-single-parser.mjs` mutates one accepted range
inside `app/admin/allowlist.ts`, and **the app's parsed array, the edge's parsed array and the
emitted nginx line all change together**, twice, with the file restored by sha256.

---

## 4. The shared-parser proof — one module, two consumers

Structural half (a permanent test, `test/admin-allowlist.test.ts`):

```
ok 10 - E-17: the parser is one module imported by both consumers, not a copy
```

It reads both sources and requires `app/env.ts` to import `./admin/allowlist.ts` and
`tools/nginx_gen.ts` to import `../app/admin/allowlist.ts`, then walks every `.ts` under `app/`
and `tools/` and fails if `isIP(` appears **anywhere but** `app/admin/allowlist.ts`. A copy would
pass every behavioural case and fail this one.

Behavioural half — the acceptance criterion's mutation, run:

```
$ node scripts/proof/allowlist-single-parser.mjs
baseline         {"app":["203.0.113.0/24"],"edge":["203.0.113.0/24"],"allow":["allow 203.0.113.0/24;"]}
mutated parser   {"app":["198.51.100.0/24"],"edge":["198.51.100.0/24"],"allow":["allow 198.51.100.0/24;"]}
restored         {"app":["203.0.113.0/24"],"edge":["203.0.113.0/24"],"allow":["allow 203.0.113.0/24;"]}
mutated again    {"app":["198.51.100.0/24"],"edge":["198.51.100.0/24"],"allow":["allow 198.51.100.0/24;"]}
restored again   sha256 matches
proof: PASS — one module, two consumers: app, edge parser and emitted nginx line all moved
EXIT=0
```

`app` is `loadEnv(...).adminAllowlist`; `edge` is `parseAdminAllowlistFrom(process.env)` — the
call `main()` makes; `allow` is the `allow` line in `generateAppConf`'s admin block. Each
measurement is a fresh `node` process, so a module cache cannot hide a second implementation. The
mutation is applied in place and restored in a `finally`, and the script exits non-zero if the
sha256 does not come back — a proof that cannot leave the tree dirty.

---

## 5. Negative controls — each gate goes red when its behaviour is broken

Method: `shasum -a 256` baseline → mutate → run the one affected file → restore → verify the hash
→ re-run green. Script: `scratch/s2c/negative-controls.sh`.

| # | Mutation | Red output | Green after restore |
|---|---|---|---|
| M1 | `nginx_gen.ts` stops emitting the allow/deny lines (`if (false)`) | `not ok 14 - E-17: a populated list emits one allow per block plus deny all;` (16 tests, 1 fail) | 16/16 |
| M2 | the parser treats an unparseable token as empty (E-17's forbidden alternative) | `not ok 12 - E-17 — a non-empty malformed value refuses the boot, naming the token` (12 tests, 1 fail) | 12/12 |
| M3 | `createRow` stops writing its `cms_audit` row | `not ok 2 - CRUD-4 …`, `not ok 3 - CRUD-5 …` (11 tests, 2 fail) | 11/11 |
| M4 | the trigger's named code is no longer mapped to the taxonomy | `not ok 6 - CRUD-8. delete of a row another table references is the taxonomy 409, not a 500` (11 tests, 1 fail) | 11/11 |
| M5 | the write path is handed `render-read` instead of `admin-write` | `not ok 2,3,4,5,6,7` — create, edit, delete, refused-write, referenced-delete, key-in-use (11 tests, 6 fail) | 11/11 |

All five restored with `restored: sha256 ok`, and the full suite green afterwards (§2).

---

## 6. Decisions, spec gaps, and what is not done

1. **The audit chain's canonical row is not defined by the SDS.** §9.6 says "`prev_hash`, `hash`
   over the canonical row" and stops. This slice defines it: `sha256(prev_hash +
   json(row, keys sorted))` where the row is
   `{actor_user_id, actor_label, action, target_kind, target_id, before_json, after_json, ts}`,
   exported as `auditHash()` so a verifier uses the writer's definition rather than inventing a
   second one. `scripts/model/verify_claims.py` check 25 hashes a *three-field* measurement record
   (`actor`, `action`, `target`) — it is a measurement, not a verifier of these rows, and the two
   must not be conflated. A verifier and the daily `audit_seal` writer are still missing (below).
2. **D28 makes a no-JS form post impossible, and this slice does not hide it.** The CSRF token is
   a header with "no form-field alternative", so the generated forms carry the token in
   `data-csrf-token` and submit through `fetch`; a plain form post is `403 SKW_E_SEC_CSRF` and the
   page says so in a `<noscript>`. CRUD-13 asserts the refusal. A future decision to allow a
   form-field token would be a change to D28, not to this file.
3. **The parser refuses a CIDR with host bits set** (`10.0.0.5/24`). E-17 is silent; the
   alternative is to mask the address silently or to emit a value `nginx -t` may reject after the
   boot has already accepted it. The message names the token and says what is wrong.
4. **`app/ddl/emit.ts` defines the SQL text, because §4.4 fixes the AST and not the text.**
   `BOOLEAN → INTEGER + CHECK (c IN (0,1))`, `DATE → TEXT` (ISO-8601), `ASSET/PAGE/RELATION` →
   the derived `REFERENCES`, no `STRICT` (§4.4 carries `NUMERIC`, which a STRICT table cannot
   declare). **S2d must execute this emitter**; a second string builder would make the preview a
   claim about SQL nobody runs, which is the one thing worse than no preview.
5. **The builder previews `create_table` only.** The other six `DdlOp` members, the five refusals
   that need execution context (`default_required`, `rebuild_required`, `too_many_statements`) and
   the whole runner are S2d (§7). The preview opens no database handle at all, so "not executed"
   is a fact (BUILD-4 asserts `u_*` is empty afterwards).
6. **`accessLogPath` is a build option, not a product feature.** It exists so E-17's gate can
   assert absence from the app's own log. It is off unless a caller names a file, and it is not an
   environment name.
7. **`SKW_ADMIN_ALLOWLIST` had to reach the container.** `docker-compose.yml` enumerates every
   name, so the value would have been dropped on the floor: the app would see empty (TOTP
   mandatory) while nginx admitted listed peers. Added to compose, `install.sh`'s `.env` writer
   and `.env.example`, empty in every bundle.
8. **`test/onboarding.test.ts` had to pass the environment to its `nginx_gen` child.** The
   generator now requires `SKW_ADMIN_ORIGIN` (it derives the admin host from it); the child
   previously ran with `process.env` only. The flags it passes still win.
9. **Not done, and named so it is not discovered later:** no `audit_seal` writer and no chain
   verifier (§9.6's second half); no index builder (`create_index`); no Kysely types from
   `columns_json`; no datasource registry or publish gate (S2's other criteria, still open from
   S2b); the tenant-plane audit chain is per-file with no anchor, so a deleted tail is invisible
   until the seal exists.

---

## 7. What S2d must build first

**The `DdlOp` runner over `app/ddl/emit.ts`.** In this order:

1. `BEGIN IMMEDIATE` → `emitCreateTable(op)` (or the emitter's sibling for the other six ops) →
   the `cms_table_registry` row and the `cms_audit` row **in the same transaction** → the
   postcondition "no table outside `cms_|u_|p_|sqlite_`" → `COMMIT`; on any failure `ROLLBACK`
   and **discard the connection, never return it to a pool** (§9.4).
2. The six remaining ops (`add_column`, `drop_column` with the 12-step rebuild,
   `rename_table`, `create_index`, `drop_index`, `drop_table`) and the three refusals that need
   context — `default_required`, `rebuild_required`, `too_many_statements` — as
   `422 SKW_E_DM_DDL_REJECTED` with the reason, before any SQL.
3. A chain verifier that calls `auditHash()` from `app/admin/crud.ts`, and the `audit_seal` writer
   it anchors to. Without them the audit rows this slice writes are chained but unanchored: a
   deleted tail still verifies.
